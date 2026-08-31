// 世界(存档)管理: 列表/切换/上传自定义存档/本地导入
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const https = require('https');
const http = require('http');

class Worlds {
  constructor(bdsCfg, bds) {
    this.cfg = bdsCfg;
    this.bds = bds;
    this.worldDir = bdsCfg.worldDir || path.join(bdsCfg.dir, 'worlds');
    this._cache = null;
  }

  /** 刷新世界列表缓存 (导入/切换后调用, 心跳上报用) */
  async refreshCache() {
    try { this._cache = await this.list(); } catch (e) { console.error('[MC1life] 世界列表缓存刷新失败:', e.message); }
    return this._cache;
  }

  /** 读取缓存 (无缓存时异步刷新) */
  async getCached() {
    if (!this._cache) await this.refreshCache();
    return this._cache || [];
  }

  /** 列出 worlds/ 下的所有世界 */
  async list() {
    if (!fs.existsSync(this.worldDir)) return [];
    const out = [];
    const props = await this._readProps();
    const current = (props['level-name'] || 'Bedrock level').replace(/\r/g, '');
    for (const entry of fs.readdirSync(this.worldDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.worldDir, entry.name);
      const stat = fs.statSync(dir);
      const hasLevel = fs.existsSync(path.join(dir, 'level.dat'));
      out.push({
        name: entry.name,
        size: await this._dirSize(dir),
        mtime: stat.mtime,
        isCurrent: entry.name === current,
        hasLevelDat: hasLevel,
      });
    }
    return out.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : b.mtime - a.mtime));
  }

  /** 切换当前世界 */
  async switchTo(name) {
    const worlds = await this.list();
    if (!worlds.some(w => w.name === name)) throw new Error(`世界不存在: ${name}`);
    const propsPath = path.join(this.cfg.dir, 'server.properties');
    const props = await this._readProps();
    props['level-name'] = name;
    await this._writeProps(propsPath, props);
    if (this.bds.running) {
      await this.bds.restart();
    }
    return { switchedTo: name };
  }

  /** 删除世界 (仅非当前世界, 路径防逃逸) */
  async delete(name) {
    if (!name || typeof name !== 'string') throw new Error('缺少世界名');
    // 防路径逃逸: 只允许单层目录名
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new Error('非法世界名');
    }
    const target = path.join(this.worldDir, name);
    const realDir = fs.realpathSync(this.worldDir);
    const realTarget = fs.existsSync(target) ? fs.realpathSync(target) : '';
    if (!realTarget.startsWith(realDir + path.sep)) {
      throw new Error('非法路径, 拒绝删除');
    }
    if (!fs.existsSync(target)) throw new Error(`世界不存在: ${name}`);
    // 禁止删除当前正在使用的世界
    const props = await this._readProps();
    const current = (props['level-name'] || 'Bedrock level').replace(/\r/g, '');
    if (name === current) throw new Error(`「${name}」是当前使用的世界, 请先切换到其他世界再删除`);
    fs.rmSync(target, { recursive: true, force: true });
    this.refreshCache();
    console.log(`[MC1life] 世界已删除: ${name}`);
    return { deleted: name, ok: true };
  }

  /** 从 URL 下载自定义存档并解压为新世界 (支持 .zip/.tar.gz/.mcworld) */
  async upload(url, name) {
    if (!url) throw new Error('缺少存档 URL');
    const ext = url.match(/\.(zip|tar\.gz|tgz|mcworld)(\?.*)?$/i)?.[1] || 'zip';
    const tmpFile = `/tmp/mc1life_world_${Date.now()}.${ext.replace('.', '')}`;
    await this._download(url, tmpFile);
    try {
      return await this._importFromFile(tmpFile, name);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  /** 从本地文件导入 (面板分片上传落盘后调用) */
  async importLocal(localFile, name) {
    if (!localFile || !fs.existsSync(localFile)) throw new Error('本地文件不存在: ' + localFile);
    return await this._importFromFile(localFile, name);
  }

  /** 核心: 解压/校验/移动为世界目录 */
  async _importFromFile(tmpFile, name) {
    const ext = tmpFile.match(/\.(zip|tar\.gz|tgz|mcworld)$/i)?.[1] || 'zip';
    const baseName = name || 'uploaded_world_' + Date.now();
    let targetName = baseName;
    let target = path.join(this.worldDir, targetName);
    let n = 2;
    while (fs.existsSync(target)) {
      targetName = `${baseName}_${n}`;
      target = path.join(this.worldDir, targetName);
      n++;
    }
    fs.mkdirSync(target, { recursive: true });

    if (ext === 'zip' || ext === 'mcworld') {
      await execFileP('unzip', ['-oq', tmpFile, '-d', target]);
    } else {
      await execFileP('tar', ['-xzf', tmpFile, '-C', target]);
    }
    // 处理嵌套目录: 若解压后只有一层目录且含 level.dat, 上移
    const items = fs.readdirSync(target);
    if (items.length === 1) {
      const inner = path.join(target, items[0]);
      if (fs.statSync(inner).isDirectory()) {
        const innerHasLevel = fs.existsSync(path.join(inner, 'level.dat'));
        const outerHasLevel = fs.existsSync(path.join(target, 'level.dat'));
        if (innerHasLevel && !outerHasLevel) {
          // 逐个移动 (execFile 不经过 shell, glob 不展开)
          for (const f of fs.readdirSync(inner)) {
            fs.renameSync(path.join(inner, f), path.join(target, f));
          }
          fs.rmdirSync(inner);
        }
      }
    }
    if (!fs.existsSync(path.join(target, 'level.dat'))) {
      fs.rmSync(target, { recursive: true, force: true });
      throw new Error('上传的存档缺少 level.dat, 可能不是有效的 Minecraft 世界');
    }
    return { world: path.basename(target), ok: true };
  }

  _download(url, dest) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent': 'MC1life-Agent' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return this._download(new URL(res.headers.location, url).toString(), dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`下载失败 HTTP ${res.statusCode}`)); }
        const ws = fs.createWriteStream(dest);
        res.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('下载超时')));
    });
  }

  async _dirSize(dir) {
    try {
      const { stdout } = await execFileP('du', ['-sb', dir], { timeout: 15000 });
      return parseInt(stdout.split('\t')[0], 10) || 0;
    } catch { return 0; }
  }

  async _readProps() {
    const p = path.join(this.cfg.dir, 'server.properties');
    const map = {};
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) map[m[1].trim()] = m[2].trim();
      }
    }
    return map;
  }

  async _writeProps(file, map) {
    let out = '';
    for (const [k, v] of Object.entries(map)) out += `${k}=${v}\n`;
    fs.writeFileSync(file, out, 'utf8');
  }
}

module.exports = Worlds;
