// 备份管理 v2: 打包 worlds -> Worker D1 staging (分片 HTTP) + 列表 + 回滚 + 删除
// 背景: 阿里云 -> Cloudflare R2 S3 的 TLS 握手被 CF 拒绝 (EPROTO handshake failure),
//       而 pages.dev (Worker) 可达 → 备份/回滚改走 Worker staging (与存档上传/导出同机制)。
// 备份类型 (kind): manual=手动 | auto=定时 | death=玩家死亡自动(含 player/reason)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const http = require('http');
const https = require('https');

const CHUNK = 716 * 1024;   // 与面板上传一致 (base64 ~955KB < D1 单行 1MB)

class Backup {
  /**
   * @param {object} bdsCfg    - { dir, worldDir, ... }
   * @param {object} r2Cfg     - 兼容旧参 (不再直连 R2, 保留接口)
   * @param {object} backupCfg - { auto, intervalMinutes, keep, includeDirs, deathKeepPerPlayer, deathKeepGlobal }
   * @param {object} bds       - BDS 实例 (stop/start/running)
   * @param {object} rcon      - { exec }
   * @param {object} poll      - PollClient ({ _base(), _auth(), config })
   */
  constructor(bdsCfg, r2Cfg, backupCfg, bds, rcon, poll) {
    this.bdsCfg = bdsCfg;
    this.cfg = backupCfg || {};
    this.bds = bds;
    this.rcon = rcon;
    this.poll = poll; // { _base(), _auth() }
  }

  _base() { return this.poll._base(); }
  _auth() { return this.poll._auth(); }

  /** poll (PollClient) 后置绑定 — backup 实例可能先于 poll 构造 */
  bindPoll(poll) { this.poll = poll; return this; }

  _req(method, urlPath, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const url = `${this._base()}${urlPath}?${this._auth()}`;
      const mod = url.startsWith('https') ? https : http;
      const data = body ? JSON.stringify(body) : null;
      const req = mod.request(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-agent-token': this.poll.config?.token || '',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: timeoutMs,
      }, (res) => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch { resolve({ ok: false, error: '响应解析失败: ' + buf.slice(0, 200) }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      if (data) req.write(data);
      req.end();
    });
  }

  /** 上传分片到 Worker staging (kind=backup) */
  async _uploadChunks(backupId, filePath, meta) {
    const full = fs.readFileSync(filePath);
    const total = Math.ceil(full.length / CHUNK);
    const size = full.length;
    const rotation = meta.rotation || null;
    // 1. start
    const st = await this._req('POST', '/api/agent/backup/start', {
      backupId, name: meta.name, kind: meta.kind, player: meta.player || '',
      reason: meta.reason || '', totalChunks: total, size, rotation,
    }, 20000);
    if (!st.ok) throw new Error('备份会话创建失败: ' + (st.error || ''));
    // 2. 逐片
    for (let i = 0; i < total; i++) {
      const slice = full.slice(i * CHUNK, Math.min((i + 1) * CHUNK, size));
      const r = await this._req('POST', '/api/agent/backup/chunk', { backupId, index: i, data: slice.toString('base64') }, 60000);
      if (!r.ok) throw new Error(`分片 ${i + 1}/${total} 上传失败: ${r.error || ''}`);
      if (i % 40 === 0) console.log(`[MC1life] 备份上传分片 ${i + 1}/${total} (${(size / 1048576).toFixed(1)}MB)`);
    }
    // 3. complete (Worker 端校验 + 轮转)
    const cp = await this._req('POST', '/api/agent/backup/complete', { backupId }, 30000);
    if (!cp.ok) throw new Error('备份完成确认失败: ' + (cp.error || ''));
    return { totalChunks: total, size };
  }

  /** 创建备份: save hold -> tar.gz -> 上传 Worker -> save resume */
  async create(name = 'manual', opts = {}) {
    const kind = opts.kind || (name.startsWith('auto') ? 'auto' : 'manual');
    const bdsDir = this.bdsCfg.dir;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
    const backupId = `${safeName}_${ts}`;
    const tmpFile = `/tmp/mc1life_backup_${Date.now()}.tar.gz`;

    // 1. 让 BDS 暂停存档写入 (若在运行)
    let saveHeld = false;
    if (this.rcon) {
      try { await this.rcon.exec('save hold'); await this.rcon.exec('save query'); saveHeld = true; } catch {}
    }

    try {
      // 2. 打包 (tar 排除临时/日志; GNU tar: --exclude 必须位于文件参数之前)
      // 过滤不存在项 (如 1.21.90 无 whitelist.json, 只有 allowlist.json)
      const includes = (this.cfg.includeDirs || ['worlds'])
        .filter(p => fs.existsSync(path.join(bdsDir, p)));
      if (!includes.length) includes.push('worlds');
      const args = ['-czf', tmpFile, '--exclude=*.tmp', '--exclude=session.lock', ...includes];
      await execFileP('tar', args, { cwd: bdsDir, maxBuffer: 256 * 1024 * 1024 });
      const size = fs.statSync(tmpFile).size;

      // 3. 上传 Worker staging
      const rotation = {
        group: kind === 'death' ? 'death' : kind,   // manual|auto|death
        keep: kind === 'death' ? (this.cfg.deathKeepPerPlayer || 3)
          : kind === 'auto' ? (this.cfg.keep || 5) : 0,
        globalKeep: kind === 'death' ? (this.cfg.deathKeepGlobal || 30) : 0,
      };
      const meta = { name: safeName, kind, player: opts.player || '', reason: opts.reason || '', rotation };
      const { totalChunks } = await this._uploadChunks(backupId, tmpFile, meta);
      console.log(`[MC1life] 备份完成: ${backupId} kind=${kind}${opts.player ? ' player=' + opts.player : ''} (${(size / 1048576).toFixed(1)}MB, ${totalChunks}片)`);
      return { backupId, name: safeName, kind, size, ts, totalChunks, ok: true };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (saveHeld && this.rcon) { try { await this.rcon.exec('save resume'); } catch {} }
    }
  }

  /** 列表: 直查 Worker staging (不经 R2) */
  async list() {
    const r = await this._req('GET', '/api/agent/backup/list', null, 20000);
    if (!r.ok) throw new Error(r.error || '备份列表获取失败');
    return (r.result || []).map(b => ({
      backupId: b.backupId,
      name: b.name,
      kind: b.kind,
      player: b.player || '',
      reason: b.reason || '',
      ts: b.ts,
      size: b.size,
      lastModified: b.lastModified || new Date(b.ts || Date.now()).toISOString(),
      totalChunks: b.totalChunks,
    }));
  }

  /** 删除备份 (Worker 直删) */
  async remove(backupId) {
    const r = await this._req('POST', '/api/agent/backup/delete', { backupId }, 20000);
    if (!r.ok) throw new Error(r.error || '删除失败');
    return { ok: true, deleted: true };
  }

  /** 回滚: 拉取分片 -> 停服 -> 解压覆盖 -> 重启 */
  async restore(backupId) {
    const bds = this.bds;
    // 1. 拉 meta
    const list = await this.list();
    const meta = list.find(b => b.backupId === backupId);
    if (!meta) throw new Error(`备份不存在: ${backupId}`);
    // 2. 拉分片拼接
    const tmpFile = `/tmp/mc1life_restore_${Date.now()}.tar.gz`;
    const total = meta.totalChunks;
    const chunks = [];
    const CONC = 6;
    console.log(`[MC1life] 回滚: 拉取备份 ${backupId} (${total} 片, ${(meta.size / 1048576).toFixed(1)}MB)`);
    for (let i = 0; i < total; i += CONC) {
      const batch = [];
      for (let j = i; j < Math.min(i + CONC, total); j++) {
        batch.push(new Promise((resolve, reject) => {
          const url = `${this._base()}/api/agent/backup/${encodeURIComponent(backupId)}/${j}?${this._auth()}`;
          const mod = url.startsWith('https') ? https : http;
          const req = mod.get(url, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => res.statusCode === 200 ? resolve(Buffer.from(buf, 'base64')) : reject(new Error(`分片 ${j} 拉取失败 HTTP ${res.statusCode}`)));
          });
          req.on('error', reject);
          req.setTimeout(60000, () => req.destroy(new Error(`分片 ${j} 超时`)));
        }));
      }
      const rs = await Promise.all(batch);
      rs.forEach((b, idx) => { chunks[i + idx] = b; });
      if (i % 40 === 0) console.log(`[MC1life] 回滚拉取分片 ${Math.min(i + CONC, total)}/${total}`);
    }
    fs.writeFileSync(tmpFile, Buffer.concat(chunks));

    // 3. 停服
    const wasRunning = bds.running;
    if (wasRunning) await bds.stop();
    try {
      // 4. 备份当前世界 (防误操作)
      const curDir = path.join(this.bdsCfg.dir, 'worlds');
      const preRollback = `${curDir}.prerollback_${Date.now()}`;
      if (fs.existsSync(curDir)) await execFileP('mv', [curDir, preRollback]);
      // 5. 解压
      await execFileP('mkdir', ['-p', curDir]);
      await execFileP('tar', ['-xzf', tmpFile, '-C', this.bdsCfg.dir]);
      await execFileP('rm', ['-rf', preRollback]).catch(() => {});
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
    // 6. 重启
    if (wasRunning) await bds.start();
    console.log(`[MC1life] 回滚完成: ${backupId}`);
    return { restored: backupId, ok: true };
  }
}

module.exports = Backup;
