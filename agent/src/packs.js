// 世界行为包/材质包管理 + 全局组件库
// 世界包: 包文件放 <世界>/behavior_packs/<包>/ 与 <世界>/resource_packs/<包>/,
//         激活状态由 <世界>/world_behavior_packs.json / world_resource_packs.json 记录 [{pack_id, version}]
// 全局库: 包放 BDS 根 behavior_packs/ resource_packs/ (排除 vanilla/chemistry/editor 系统包),
//         各世界 json 引用 uuid 即可启用 (BDS 加载时从世界目录或根目录找包)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class Packs {
  constructor(bdsCfg, bds) {
    this.cfg = bdsCfg;               // { dir: /opt/mc1life/bds, worldDir }
    this.bds = bds;
    this.worldDir = bdsCfg.worldDir || path.join(bdsCfg.dir, 'worlds');
  }

  // ---------- 内部工具 ----------

  _worldRoot(world) {
    if (!world || typeof world !== 'string') throw new Error('缺少世界名');
    if (world.includes('/') || world.includes('\\') || world === '.' || world === '..') throw new Error('非法世界名');
    const dir = path.join(this.worldDir, world);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`世界不存在: ${world}`);
    const real = fs.realpathSync(dir);
    if (!real.startsWith(fs.realpathSync(this.worldDir) + path.sep)) throw new Error('非法路径');
    return dir;
  }

  _readJsonArray(file) {
    try {
      const s = fs.readFileSync(file, 'utf8').trim();
      if (!s) return [];
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  _writeJsonArray(file, arr) {
    fs.writeFileSync(file, JSON.stringify(arr), 'utf8');
  }

  _dirSizeSync(dir) {
    let total = 0;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) total += this._dirSizeSync(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      }
    } catch {}
    return total;
  }

  /** 从 manifest 的 texts/*.lang 解析本地化名 (pack.name=...) */
  _localizedName(packDir, fallback) {
    const texts = path.join(packDir, 'texts');
    if (fs.existsSync(texts) && fs.statSync(texts).isDirectory()) {
      const want = ['zh_CN.lang', 'zh_TW.lang', 'en_US.lang'];
      for (const lang of want) {
        const f = path.join(texts, lang);
        if (!fs.existsSync(f)) continue;
        try {
          for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
            const m = line.match(/^pack\.name\s*=\s*(.+)$/);
            if (m) {
              const v = m[1].trim();
              if (v && !v.startsWith('pack.')) return v;
            }
          }
        } catch {}
      }
    }
    return fallback;
  }

  _sanitize(n) {
    return String(n).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'pack';
  }

  /** 读包目录 manifest, 返回元信息 (读不到返回 null) */
  _readManifest(packDir) {
    const mf = path.join(packDir, 'manifest.json');
    if (!fs.existsSync(mf)) return null;
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      const header = m.header || {};
      const mods = Array.isArray(m.modules) ? m.modules : [];
      return {
        uuid: String(header.uuid || ''),
        version: header.version || [1, 0, 0],
        headerName: String(header.name || ''),
        moduleTypes: mods.map(x => x.type).filter(Boolean),
        raw: m,
      };
    } catch { return null; }
  }

  /** 系统内置包 (不出现在列表: BDS 自带 vanilla/chemistry/education 及历史版本前缀) */
  isSystemPack(folder) {
    const f = String(folder || '');
    return f === 'vanilla' || f === 'chemistry' || f === 'editor' || f === 'education' ||
      f.startsWith('vanilla_') || f.startsWith('chemistry_') || f.startsWith('education_') || f.startsWith('experimental_');
  }

  /** 扫 root/rel 目录下的包 */
  _scanDir(root, rel, type, activeSet, source) {
    const out = [];
    const dir = path.join(root, rel);
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (this.isSystemPack(entry.name)) continue;
      const pdir = path.join(dir, entry.name);
      const mf = this._readManifest(pdir);
      const uuid = mf ? mf.uuid : '';
      out.push({
        uuid,
        folder: entry.name,
        name: mf ? this._localizedName(pdir, mf.headerName || entry.name) : entry.name,
        version: Array.isArray(mf?.version) ? mf.version.join('.') : '1.0.0',
        type,
        size: this._dirSizeSync(pdir),
        enabled: uuid ? activeSet.has(uuid) : activeSet.has(entry.name),
        hasManifest: !!mf,
        source,
      });
    }
    return out;
  }

  /** 按 uuid 或文件夹名在世界目录内找包 */
  _findPack(root, uuid) {
    for (const rel of ['behavior_packs', 'resource_packs']) {
      const dir = path.join(root, rel);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pdir = path.join(dir, entry.name);
        const mf = this._readManifest(pdir);
        const packUuid = mf ? mf.uuid : '';
        if ((uuid && packUuid === uuid) || (!uuid && entry.name === uuid)) {
          return { type: rel === 'behavior_packs' ? 'behavior' : 'resource', folder: entry.name, dir: pdir, mf };
        }
      }
    }
    return null;
  }

  /** 按 uuid 找包: 世界内优先, 其次全局库 */
  _findPackAnywhere(world, uuid) {
    if (world) {
      try {
        const root = this._worldRoot(world);
        const f = this._findPack(root, uuid);
        if (f) return { ...f, source: 'world' };
      } catch {}
    }
    for (const rel of ['behavior_packs', 'resource_packs']) {
      const dir = path.join(this.cfg.dir, rel);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || this.isSystemPack(entry.name)) continue;
        const pdir = path.join(dir, entry.name);
        const mf = this._readManifest(pdir);
        if (mf && mf.uuid === uuid) {
          return { type: rel === 'behavior_packs' ? 'behavior' : 'resource', folder: entry.name, dir: pdir, mf, source: 'library' };
        }
      }
    }
    return null;
  }

  _readActiveRefs(worldDir) {
    const out = [];
    for (const [rel, type] of [['world_behavior_packs.json', 'behavior'], ['world_resource_packs.json', 'resource']]) {
      for (const x of this._readJsonArray(path.join(worldDir, rel))) {
        out.push({ pack_id: x.pack_id, type, version: x.version });
      }
    }
    return out;
  }

  _listWorldDirs() {
    if (!fs.existsSync(this.worldDir)) return [];
    return fs.readdirSync(this.worldDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(this.worldDir, e.name, 'level.dat')))
      .map(e => e.name);
  }

  // ---------- 核心 API ----------

  /** 列出某世界的全部可用包 = 世界本地包 + 全局库包 (同 uuid 本地优先) */
  list(world) {
    const root = this._worldRoot(world);
    const activeBehavior = new Set(this._readJsonArray(path.join(root, 'world_behavior_packs.json')).map(x => x.pack_id));
    const activeResource = new Set(this._readJsonArray(path.join(root, 'world_resource_packs.json')).map(x => x.pack_id));
    const out = { world, behavior: [], resource: [] };
    const localB = this._scanDir(root, 'behavior_packs', 'behavior', activeBehavior, 'world');
    const localR = this._scanDir(root, 'resource_packs', 'resource', activeResource, 'world');
    const seen = new Set();
    for (const p of localB) { out.behavior.push(p); if (p.uuid) seen.add(p.uuid); }
    for (const p of localR) { out.resource.push(p); if (p.uuid) seen.add(p.uuid); }
    for (const p of this._scanDir(this.cfg.dir, 'behavior_packs', 'behavior', activeBehavior, 'library')) {
      if (!seen.has(p.uuid)) { out.behavior.push(p); seen.add(p.uuid); }
    }
    for (const p of this._scanDir(this.cfg.dir, 'resource_packs', 'resource', activeResource, 'library')) {
      if (!seen.has(p.uuid)) { out.resource.push(p); seen.add(p.uuid); }
    }
    return out;
  }

  /** 全局组件库: 根目录所有非系统包 + 被哪些世界引用 */
  library() {
    const out = { behavior: [], resource: [] };
    const refs = {};
    for (const wname of this._listWorldDirs()) {
      for (const ref of this._readActiveRefs(path.join(this.worldDir, wname))) {
        if (!refs[ref.pack_id]) refs[ref.pack_id] = [];
        if (!refs[ref.pack_id].includes(wname)) refs[ref.pack_id].push(wname);
      }
    }
    const scanLib = (rel, type, list) => {
      for (const p of this._scanDir(this.cfg.dir, rel, type, new Set(), 'library')) {
        p.refWorlds = refs[p.uuid] || [];
        p.refCount = p.refWorlds.length;
        list.push(p);
      }
    };
    scanLib('behavior_packs', 'behavior', out.behavior);
    scanLib('resource_packs', 'resource', out.resource);
    return out;
  }

  /** 启用/停用某世界的包 (改 world_*_packs.json; 包可在世界内或全局库) */
  toggle(world, uuid, enabled) {
    const root = this._worldRoot(world);
    const found = this._findPackAnywhere(world, uuid);
    if (!found) throw new Error(`未找到该包 (uuid=${uuid})`);
    const type = found.type;
    const relFile = type === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json';
    const file = path.join(root, relFile);
    const arr = this._readJsonArray(file);
    const version = found.mf ? found.mf.version : [1, 0, 0];

    if (enabled) {
      if (!arr.some(x => x.pack_id === uuid)) {
        arr.push({ pack_id: uuid, version });
        this._writeJsonArray(file, arr);
      }
      return { ok: true, world, type, folder: found.folder, source: found.source, enabled: true, note: '包已启用, 重启世界后生效' };
    }
    const filtered = arr.filter(x => x.pack_id !== uuid);
    if (filtered.length !== arr.length) {
      this._writeJsonArray(file, filtered);
    }
    return { ok: true, world, type, folder: found.folder, source: found.source, enabled: false, note: '包已停用, 重启世界后生效' };
  }

  /** 删除世界内包 (停用 + 删世界内目录) */
  remove(world, uuid) {
    const root = this._worldRoot(world);
    const found = this._findPack(root, uuid);
    if (!found) throw new Error(`世界内未找到该包 (uuid=${uuid}), 库包请从组件库删除`);
    this.toggle(world, uuid, false);
    fs.rmSync(found.dir, { recursive: true, force: true });
    return { ok: true, world, folder: found.folder, deleted: true };
  }

  /** 从 zip 安装到全局库 (根目录), 不自动启用 */
  /** 从 zip 安装到指定世界目录 (behavior_packs/resource_packs) 并自动启用 */
  installZip(world, tmpFile, forcedType) {
    const root = this._worldRoot(world);
    const staging = path.join(root, `.packs_staging_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(staging, { recursive: true });
    const installed = [];
    try {
      this._extractZip(tmpFile, staging);
      const packDirs = this._discoverPacks(staging);
      if (!packDirs.length) throw new Error('压缩包内未找到含 manifest.json 的行为/材质包');
      for (const pd of packDirs) {
        const mf = this._readManifest(pd);
        const type = this._detectType(pd, forcedType, staging);
        const typeDir = type === 'behavior' ? 'behavior_packs' : 'resource_packs';
        const destBase = path.join(root, typeDir);
        fs.mkdirSync(destBase, { recursive: true });
        let base = path.basename(pd);
        if (path.resolve(pd) === path.resolve(staging)) base = mf?.headerName || 'pack';
        base = this._sanitize(base);
        let dest = path.join(destBase, base);
        let n = 2;
        while (fs.existsSync(dest)) { dest = path.join(destBase, `${base}_${n}`); n++; }
        fs.mkdirSync(dest, { recursive: true });
        for (const f of fs.readdirSync(pd)) {
          const src = path.join(pd, f);
          try { fs.renameSync(src, path.join(dest, f)); }
          catch { fs.cpSync(src, path.join(dest, f), { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
        }
        // 默认启用
        const uuid = mf?.uuid || '';
        const relFile = type === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json';
        const file = path.join(root, relFile);
        const arr = this._readJsonArray(file);
        if (uuid && !arr.some(x => x.pack_id === uuid)) {
          arr.push({ pack_id: uuid, version: mf?.version || [1, 0, 0] });
          this._writeJsonArray(file, arr);
        }
        installed.push({
          folder: path.basename(dest),
          name: mf ? this._localizedName(dest, mf.headerName || base) : base,
          uuid,
          type,
          version: mf?.version?.join('.') || '1.0.0',
          enabled: true,
        });
      }
      return { ok: true, world, installed };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** 从 zip 安装到全局库 (根目录), 不自动启用 */
  installToLibrary(tmpFile, forcedType) {
    const staging = path.join(this.worldDir, `.packs_staging_lib_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(staging, { recursive: true });
    const installed = [];
    try {
      this._extractZip(tmpFile, staging);
      const packDirs = this._discoverPacks(staging);
      if (!packDirs.length) throw new Error('压缩包内未找到含 manifest.json 的行为/材质包');
      for (const pd of packDirs) {
        const mf = this._readManifest(pd);
        const type = this._detectType(pd, forcedType, staging);
        const typeDir = type === 'behavior' ? 'behavior_packs' : 'resource_packs';
        const destBase = path.join(this.cfg.dir, typeDir);
        fs.mkdirSync(destBase, { recursive: true });
        let base = path.basename(pd);
        if (path.resolve(pd) === path.resolve(staging)) base = mf?.headerName || 'pack';
        base = this._sanitize(base);
        let dest = path.join(destBase, base);
        let n = 2;
        while (fs.existsSync(dest)) { dest = path.join(destBase, `${base}_${n}`); n++; }
        fs.mkdirSync(dest, { recursive: true });
        for (const f of fs.readdirSync(pd)) {
          const src = path.join(pd, f);
          try { fs.renameSync(src, path.join(dest, f)); }
          catch { fs.cpSync(src, path.join(dest, f), { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
        }
        installed.push({
          folder: path.basename(dest),
          name: mf ? this._localizedName(dest, mf.headerName || base) : base,
          uuid: mf?.uuid || '',
          type,
          version: mf?.version?.join('.') || '1.0.0',
        });
      }
      return { ok: true, installed, note: '已上传到组件库, 到各世界配置中启用' };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** 从全局库删除: 删根目录包 + 清空所有世界引用 */
  removeLibrary(uuid) {
    if (!uuid) throw new Error('缺少 uuid');
    const found = this._findPackAnywhere(null, uuid);
    if (!found || found.source !== 'library') throw new Error(`组件库中未找到该包 (uuid=${uuid})`);
    const cleared = [];
    for (const wname of this._listWorldDirs()) {
      const wdir = path.join(this.worldDir, wname);
      for (const rel of ['world_behavior_packs.json', 'world_resource_packs.json']) {
        const file = path.join(wdir, rel);
        const arr = this._readJsonArray(file);
        const filtered = arr.filter(x => x.pack_id !== uuid);
        if (filtered.length !== arr.length) {
          this._writeJsonArray(file, filtered);
          if (!cleared.includes(wname)) cleared.push(wname);
        }
      }
    }
    fs.rmSync(found.dir, { recursive: true, force: true });
    return { ok: true, folder: found.folder, type: found.type, clearedFromWorlds: cleared };
  }

  // ---------- zip / staging 工具 ----------

  /** 从已解压 staging 中识别包 (含 staging 根自身; 收集含 manifest.json 的目录) */
  _discoverPacks(staging) {
    const hits = [];
    if (fs.existsSync(path.join(staging, 'manifest.json'))) {
      hits.push(staging);
      return hits;
    }
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === '__MACOSX' || e.name === '.DS_Store' || e.name.startsWith('._')) continue;
        const full = path.join(dir, e.name);
        if (!e.isDirectory()) continue;
        if (fs.existsSync(path.join(full, 'manifest.json'))) {
          hits.push(full);
          continue;
        }
        if (fs.existsSync(path.join(full, 'level.dat'))) continue;
        walk(full);
      }
    };
    walk(staging);
    return hits;
  }

  /** 判断包类型: 指定 > manifest modules > 路径 > 特征 */
  _detectType(packDir, forced, staging) {
    if (forced === 'behavior' || forced === 'resource') return forced;
    const mf = this._readManifest(packDir);
    if (mf && mf.moduleTypes.includes('data')) return 'behavior';
    if (mf && mf.moduleTypes.includes('resources')) return 'resource';
    const rel = path.relative(staging, packDir).replace(/\\/g, '/');
    if (/behavior_packs\//.test(rel)) return 'behavior';
    if (/resource_packs\//.test(rel)) return 'resource';
    try {
      const names = fs.readdirSync(packDir).join(' ');
      if (/\b(textures|models|texts|sounds|ui|render_controllers|materials)\b/.test(names)) return 'resource';
      if (/\b(scripts|blocks|entities|items|recipes|spawn_rules)\b/.test(names)) return 'behavior';
    } catch {}
    throw new Error('无法识别包类型 (manifest 无 modules, 请手动指定 行为包/材质包)');
  }

  /** 内置 zip 解压 (zlib + central directory; 防 zip-slip) */
  _extractZip(zipFile, destDir) {
    const buf = fs.readFileSync(zipFile);
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
      const norm = path.normalize(name).replace(/\\/g, '/');
      if (norm.startsWith('..') || path.isAbsolute(name) || norm.includes('../')) {
        throw new Error(`zip 含非法路径, 已拒绝: ${name}`);
      }
      if (name.endsWith('/')) { off += 46 + nameLen + extraLen + commentLen; continue; }
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
}

module.exports = Packs;
