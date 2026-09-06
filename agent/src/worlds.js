// 世界(存档)管理: 列表/切换/上传自定义存档/本地导入
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const zlib = require('zlib');
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
  // 支持"整个世界文件夹打包 zip": 解压后遍历整树定位 level.dat 所在目录(世界根),
  // 无视 __MACOSX/.DS_Store/多级嵌套等夹带内容; 世界名智能回退 levelname.txt
  /** 核心: 解压/校验/移动为世界目录 */
  // 支持"整个世界文件夹打包 zip": 解压后遍历整树定位 level.dat 所在目录(世界根),
  // 无视 __MACOSX/.DS_Store/多级嵌套等夹带内容; 世界名智能回退 levelname.txt
  async _importFromFile(tmpFile, name) {
    const ext = tmpFile.match(/\.(zip|tar\.gz|tgz|mcworld)$/i)?.[1] || 'zip';
    // 1) 解压到临时 staging (放 worldDir 内 = 同文件系统, 避免跨设备 rename EXDEV)
    fs.mkdirSync(this.worldDir, { recursive: true });
    const staging = path.join(this.worldDir, `.staging_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(staging, { recursive: true });
    let target = null;   // 记录已建目标目录, 失败时清理
    try {
      if (ext === 'zip' || ext === 'mcworld') {
        this._extractZip(tmpFile, staging);   // node 内置解压, 防 zip-slip
      } else {
        await execFileP('tar', ['-xzf', tmpFile, '-C', staging]);
      }
      // 2) 遍历整树定位所有 level.dat, 选最浅层 = 世界根
      const hits = [];
      this._findLevelDat(staging, staging, 0, hits);
      if (!hits.length) throw new Error('上传的存档中未找到 level.dat, 可能不是有效的 Minecraft 世界');
      hits.sort((a, b) => a.depth - b.depth || a.dir.length - b.dir.length);
      const worldRoot = hits[0].dir;
      if (hits.length > 1) console.log(`[MC1life] 存档内含多个 level.dat (${hits.length} 个), 取最浅: ${path.relative(staging, worldRoot)}`);
      // 3) 确定世界名
      const baseName = this._pickWorldName(staging, worldRoot, name);
      let targetName = baseName;
      target = path.join(this.worldDir, targetName);
      let n = 2;
      while (fs.existsSync(target)) {
        targetName = `${baseName}_${n}`;
        target = path.join(this.worldDir, targetName);
        n++;
      }
      // 4) 上移世界根内容到最终目录 (跳过打包夹带的垃圾项)
      fs.mkdirSync(target, { recursive: true });
      for (const f of fs.readdirSync(worldRoot)) {
        if (f === '__MACOSX' || f === '.DS_Store' || f.startsWith('._')) continue;
        const src = path.join(worldRoot, f);
        try {
          fs.renameSync(src, path.join(target, f));  // 同文件系统, 正常成功
        } catch (e) {
          if (e.code === 'EXDEV') {
            // 兜底: 万一仍跨设备, 复制+删除 (慢但可靠)
            fs.cpSync(src, path.join(target, f), { recursive: true });
            fs.rmSync(src, { recursive: true, force: true });
          } else throw e;
        }
      }
      if (!fs.existsSync(path.join(target, 'level.dat'))) {
        fs.rmSync(target, { recursive: true, force: true });
        throw new Error('上传的存档缺少 level.dat, 可能不是有效的 Minecraft 世界');
      }
      console.log(`[MC1life] 世界导入成功: ${path.basename(target)} (内容来自 ${path.relative(staging, worldRoot) || 'zip 根'})`);
      return { world: path.basename(target), ok: true };
    } catch (e) {
      // 失败时清理已建的目标目录 (避免残留空目录/半成品)
      if (target && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      throw e;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }



  /** 内置 zip 解压 (zlib + central directory; 免系统 unzip; 防 zip-slip 路径穿越) */
  _extractZip(zipFile, destDir) {
    const buf = fs.readFileSync(zipFile);
    // 1) 从尾部找 EOCD (0x06054b50)
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('无效的 zip 文件 (找不到目录尾)');
    const cdCount = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const realDir = path.resolve(destDir);
    let off = cdOffset;
    for (let n = 0; n < cdCount; n++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 中央目录损坏');
      const method = buf.readUInt16LE(off + 10);
      const csize = buf.readUInt32LE(off + 20);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const lho = buf.readUInt32LE(off + 42);
      let name = buf.toString('utf8', off + 46, off + 46 + nameLen);
      // 2) 安全校验: 拒绝绝对路径/../
      const norm = path.normalize(name).replace(/\\/g, '/');
      if (norm.startsWith('..') || path.isAbsolute(name) || norm.includes('../')) {
        throw new Error(`zip 含非法路径, 已拒绝: ${name}`);
      }
      if (name.endsWith('/')) { off += 46 + nameLen + extraLen + commentLen; continue; } // 目录项
      // 3) 读 local header 定位数据
      if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`zip local header 损坏: ${name}`);
      const lNameLen = buf.readUInt16LE(lho + 26);
      const lExtraLen = buf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lNameLen + lExtraLen;
      let data = buf.subarray(dataStart, dataStart + csize);
      if (method === 8) data = zlib.inflateRawSync(data);
      else if (method !== 0) throw new Error(`zip 不支持的压缩方式 ${method}: ${name}`);
      const outPath = path.join(realDir, norm);
      if (!outPath.startsWith(realDir + path.sep)) throw new Error(`zip 路径逃逸, 已拒绝: ${name}`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, data);
      off += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** 递归找 level.dat (忽略隐藏/垃圾目录), 记录深度与目录 */
  _findLevelDat(root, dir, depth, hits) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '__MACOSX' || e.name.startsWith('._')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 不深入 db/ (LevelDB 内部无 level.dat, 但避免遍历大目录)
        if (e.name === 'db' || e.name === 'DIM-1' || e.name === 'DIM1') {
          if (fs.existsSync(path.join(full, 'level.dat'))) {
            hits.push({ dir: full, depth: depth + 1 });
          }
          continue;
        }
        this._findLevelDat(root, full, depth + 1, hits);
      } else if (e.name === 'level.dat') {
        hits.push({ dir, depth });
      }
    }
  }

  /** 智能世界名: 显式名 > levelname.txt(当传入名像机器名时) > 单层目录名 > 兜底 */
  _pickWorldName(staging, worldRoot, name) {
    const looksMachine = !name || name.startsWith('uploaded_world') || /^[A-Za-z0-9+/=_-]{6,}$/.test(name);
    if (!looksMachine) return this._sanitizeName(name);
    // 尝试 levelname.txt
    const lnPath = path.join(worldRoot, 'levelname.txt');
    if (fs.existsSync(lnPath)) {
      const ln = fs.readFileSync(lnPath, 'utf8').trim().replace(/\r/g, '').slice(0, 60);
      if (ln) return this._sanitizeName(ln);
    }
    // 顶层恰单目录(且非 staging 根内容) → 用目录名
    const top = fs.readdirSync(staging).filter(x => x !== '__MACOSX' && !x.startsWith('._') && x !== '.DS_Store');
    if (top.length === 1 && worldRoot !== staging) {
      const d = fs.statSync(path.join(staging, top[0]));
      if (d.isDirectory() && path.join(staging, top[0]) === worldRoot) return this._sanitizeName(top[0]);
    }
    return this._sanitizeName(name || 'uploaded_world_' + Date.now());
  }

  _sanitizeName(n) {
    return String(n).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'world';
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
