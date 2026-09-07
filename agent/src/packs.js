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

    if (this._paper()) return this._paperList(world);    const root = this._worldRoot(world);
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

    if (this._paper()) return this._paperLibrary();    const out = { behavior: [], resource: [] };
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

    if (this._paper()) return this._paperToggle(world, uuid, enabled);    const root = this._worldRoot(world);
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

    if (this._paper()) return this._paperRemove(world, uuid);    const root = this._worldRoot(world);
    const found = this._findPack(root, uuid);
    if (!found) throw new Error(`世界内未找到该包 (uuid=${uuid}), 库包请从组件库删除`);
    this.toggle(world, uuid, false);
    fs.rmSync(found.dir, { recursive: true, force: true });
    return { ok: true, world, folder: found.folder, deleted: true };
  }

  /** 从 zip 安装到全局库 (根目录), 不自动启用 */
  /** 从 zip 安装到指定世界目录 (behavior_packs/resource_packs) 并自动启用 */
  installZip(world, tmpFile, forcedType) {

    if (this._paper()) return this._paperInstall(tmpFile, forcedType || '', world);    const root = this._worldRoot(world);
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

    if (this._paper()) return this._paperInstall(tmpFile, forcedType || '', null);    const staging = path.join(this.worldDir, `.packs_staging_lib_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
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

    if (this._paper()) return this._paperRemove(null, uuid);    if (!uuid) throw new Error('缺少 uuid');
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

// ---- Paper/Java 模式扩展 (cfg.mode==='paper') ----
// 语义设计 (双端材质包 + Java 数据包):
//  - 材质包(resource) 全服级, 双平台并存:
//      * Java 版: packs/java/<id>/<file>.zip (pack.mcmeta), 启用写 server.properties resource-pack=<静态URL>
//        (Java 客户端仅支持单 URL → 同刻只启一个 Java 包, 其余停用)
//      * 基岩版:  packs/bedrock/<id>/<file>.mcpack (manifest.json), 启用追加 Geyser resource-pack-urls (可多个)
//  - 行为包 = Java 数据包(datapack), 每世界独立: 解压到 <world>/datapacks/<id>/ 即启用
//    (双端互通; 基岩 addon 与 Java 不互通 → 一律拒绝并提示)

  _paper() { return this.cfg.mode === 'paper'; }
  _paperPublicBase() { return (this.cfg.packsBaseUrl || 'http://121.43.166.46:8080').replace(/\/$/, ''); }
  /** URL-safe id: 前缀+时间戳+随机 (仅 [A-Za-z0-9_]) */
  _paperGenId(prefix) {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 6);
    return (prefix || 'p') + '_' + ts + rnd;
  }
  _paperHome() { return path.join(this.cfg.dir, '..', 'packs'); }
  _paperJavaHome() { return path.join(this._paperHome(), 'java'); }
  _paperBedrockHome() { return path.join(this._paperHome(), 'bedrock'); }
  _paperPropsPath() { return path.join(this.cfg.dir, 'server.properties'); }
  _paperGeyserConfig() { return path.join(this.cfg.dir, 'plugins', 'Geyser-Spigot', 'config.yml'); }

  _paperReadProps() {
    const map = {};
    try {
      for (const line of fs.readFileSync(this._paperPropsPath(), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) map[m[1].trim()] = m[2].trim();
      }
    } catch {}
    return map;
  }
  _paperWriteProps(map) {
    const lines = [];
    for (const [k, v] of Object.entries(map)) lines.push(`${k}=${v}`);
    fs.writeFileSync(this._paperPropsPath(), lines.join('\n'), 'utf8');
  }

  /** 读 Geyser resource-pack-urls (支持 [] 与多行列表) */
  _paperReadGeyserUrls() {
    try {
      const s = fs.readFileSync(this._paperGeyserConfig(), 'utf8');
      const lines = s.split(/\r?\n/);
      const urls = [];
      let inUrls = false;
      for (const line of lines) {
        const t = line.trim();
        if (!inUrls) {
          if (t.startsWith('resource-pack-urls:')) {
            // 单行 [] 形式
            const m = t.match(/resource-pack-urls:\s*\[(.*?)\]/);
            if (m && m[1].trim()) {
              const parts = m[1].match(/'([^']*)'|"([^"]*)"/g);
              if (parts) parts.forEach(x => urls.push(x.slice(1, -1)));
            }
            if (m) break; // 单行结束
            inUrls = true; // 无 [] → 多行
          }
          continue;
        }
        if (t.startsWith('- ')) {
          const v = t.slice(2).trim().replace(/^['"]|['"]$/g, '');
          if (v) urls.push(v);
        } else if (t && !t.startsWith('- ')) {
          break; // 列表结束
        }
      }
      return urls;
    } catch { return []; }
  }
  /** 写 Geyser resource-pack-urls (数组 -> 多行 yaml 或 []) — 按行安全替换 */
  _paperWriteGeyserUrls(urls) {
    const cfg = this._paperGeyserConfig();
    const lines = fs.readFileSync(cfg, 'utf8').split(/\r?\n/);
    const out = [];
    let inUrls = false, replaced = false;
    for (const line of lines) {
      const t = line.trim();
      if (inUrls) {
        // 跳过旧多行列表项
        if (t.startsWith('- ')) continue;
        if (t && !t.startsWith('- ')) inUrls = false;
        else if (!t) continue;
      }
      if (!inUrls && t.startsWith('resource-pack-urls:')) {
        const hasBracket = t.includes('[');
        if (hasBracket && t.includes(']')) {
          // 单行 []: 若是空 [] 且无后继列表 → 直接替换该行
          const isEmpty = /resource-pack-urls:\s*\[\s*\]/.test(t);
          if (isEmpty) {
            out.push(urls.length ? 'resource-pack-urls:' : t);
            urls.forEach(u => out.push(`    - '${u}'`));
            replaced = true;
            continue;
          }
          // 非空单行 → 也替换 (旧值覆盖)
          out.push(urls.length ? 'resource-pack-urls:' : 'resource-pack-urls: []');
          urls.forEach(u => out.push(`    - '${u}'`));
          replaced = true;
          continue;
        }
        // 多行块起始
        if (urls.length) { out.push('resource-pack-urls:'); urls.forEach(u => out.push(`    - '${u}'`)); replaced = true; }
        else { out.push('resource-pack-urls: []'); replaced = true; }
        inUrls = true;
        continue;
      }
      out.push(line);
    }
    if (!replaced) {
      // 整个文件没有该键 → 追加
      out.push('resource-pack-urls:' + (urls.length ? '' : ' []'));
      urls.forEach(u => out.push(`    - '${u}'`));
    }
    fs.writeFileSync(cfg, out.join('\n'), 'utf8');
  }

  /** Java 资源包: 当前启用的 URL (server.properties resource-pack) */
  _paperJavaActiveUrl() { return this._paperReadProps()['resource-pack'] || ''; }

  /** 扫描某库目录的包 (读 meta.json) */
  _paperScanLib(home) {
    if (!fs.existsSync(home)) return [];
    const out = [];
    for (const e of fs.readdirSync(home, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(home, e.name);
      const metaFile = path.join(dir, 'meta.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
      const file = meta.file || (fs.readdirSync(dir).find(f => /\.(zip|mcpack|mcworld)$/i.test(f)) || '');
      const size = file ? (fs.statSync(path.join(dir, file)).size || 0) : 0;
      out.push({
        uuid: e.name, folder: e.name,
        name: meta.name || e.name,
        size,
        file,
        addedAt: meta.addedAt || 0,
        originalName: meta.originalName || '',
        platform: meta.platform || (this.cfg.dir.includes('java') ? 'java' : 'bedrock'),
      });
    }
    return out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  /** 扫描某世界 datapacks */
  _paperScanDatapacks(world) {
    const root = this._worldRoot(world); // 校验世界存在
    const dpDir = path.join(root, 'datapacks');
    if (!fs.existsSync(dpDir)) return [];
    const out = [];
    for (const e of fs.readdirSync(dpDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(dpDir, e.name);
      const mcmeta = path.join(dir, 'pack.mcmeta');
      if (!fs.existsSync(mcmeta)) continue;
      let desc = '';
      try { const j = JSON.parse(fs.readFileSync(mcmeta, 'utf8')); desc = (j.pack && j.pack.description) || ''; } catch {}
      out.push({
        uuid: e.name, folder: e.name,
        name: e.name,
        description: typeof desc === 'string' ? desc.slice(0, 120) : JSON.stringify(desc).slice(0, 120),
        size: this._dirSizeSync(dir),
        platform: 'datapack',
        source: 'world',
        enabled: true, // 存在于 datapacks 即启用
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** paper 模式列表: 某世界 datapacks + 全服资源包(java/bedrock) */
  async _paperList(world) {
    const datapacks = this._paperScanDatapacks(world);
    const javaRps = this._paperScanLib(this._paperJavaHome()).map(p => ({
      ...p, platform: 'java',
      enabled: this._paperJavaActiveUrl().includes(p.file),
      url: `${this._paperPublicBase()}/java/${p.folder}/${p.file}`,
    }));
    const geyserUrls = this._paperReadGeyserUrls();
    const bedrockRps = this._paperScanLib(this._paperBedrockHome()).map(p => ({
      ...p, platform: 'bedrock',
      enabled: geyserUrls.some(u => u.includes(p.file)),
      url: `${this._paperPublicBase()}/bedrock/${p.folder}/${p.file}`,
    }));
    return { world, datapacks, resources: { java: javaRps, bedrock: bedrockRps } };
  }

  /** paper 组件库: 全服资源包 (不依赖世界) */
  async _paperLibrary() {
    return { datapacks: [], resources: { java: this._paperScanLib(this._paperJavaHome()), bedrock: this._paperScanLib(this._paperBedrockHome()) } };
  }

  /** paper 启停: id 可能是 datapack 名 / java包folder / bedrock包folder */
  async _paperToggle(world, id, enabled) {
    if (!id) throw new Error('缺少包 ID');
    // 1) datapack: Java 数据包在 datapacks 即启用, 无独立开关 → 提示
    try {
      const dps = this._paperScanDatapacks(world);
      if (dps.some(d => d.uuid === id)) {
        return { ok: true, platform: 'datapack', world, id, enabled: true,
          note: 'Java 数据包放入 datapacks/ 即启用 (双端互通); 停用请删除该数据包' };
      }
    } catch {}
    // 2) java 资源包 (单 URL, 启用=替换 resource-pack)
    const jHome = this._paperJavaHome();
    const jDir = path.join(jHome, id);
    if (fs.existsSync(jDir)) {
      const meta = this._paperMeta(jDir);
      const props = this._paperReadProps();
      if (enabled) {
        // 同刻只启一个 Java 包 → 清掉旧的, 写入新的
        props['resource-pack'] = `${this._paperPublicBase()}/java/${id}/${meta.file}`;
        props['resource-pack-sha1'] = this._sha1(path.join(jDir, meta.file));
        this._paperWriteProps(props);
      } else if (this._paperJavaActiveUrl().includes(meta.file)) {
        delete props['resource-pack'];
        delete props['resource-pack-sha1'];
        this._paperWriteProps(props);
      }
      return { ok: true, platform: 'java', world, id, enabled,
        note: enabled ? '已启用为 Java 材质包 (仅 Java 玩家), 重启服务端生效' : '已停用 Java 材质包, 重启生效' };
    }
    // 3) bedrock 资源包 (可多个, 写 Geyser urls)
    const bDir = path.join(this._paperBedrockHome(), id);
    if (fs.existsSync(bDir)) {
      const meta = this._paperMeta(bDir);
      const url = `${this._paperPublicBase()}/bedrock/${id}/${meta.file}`;
      let urls = this._paperReadGeyserUrls();
      if (enabled && !urls.includes(url)) urls.push(url);
      if (!enabled) urls = urls.filter(u => u !== url);
      this._paperWriteGeyserUrls(urls);
      return { ok: true, platform: 'bedrock', world, id, enabled,
        note: enabled ? '已加入 Geyser 推送 (仅基岩玩家), 重启服务端生效' : '已从 Geyser 移除, 重启生效' };
    }
    throw new Error(`未找到包: ${id}`);
  }

  /** paper 删除: datapack 删世界内目录; 资源包删库目录(顺带清理启用引用) */
  async _paperRemove(world, id) {
    if (!id) throw new Error('缺少包 ID');
    // datapack
    try {
      const dps = this._paperScanDatapacks(world);
      if (dps.some(d => d.uuid === id)) {
        const dpDir = path.join(this._worldRoot(world), 'datapacks', id);
        fs.rmSync(dpDir, { recursive: true, force: true });
        return { ok: true, platform: 'datapack', world, id, deleted: true, note: '数据包已删除, 双端即时生效(可 /reload 或重启)' };
      }
    } catch {}
    // 先停用(清理 server.properties / geyser urls), 再删目录
    try { await this._paperToggle(world, id, false); } catch {}
    const home = fs.existsSync(path.join(this._paperJavaHome(), id)) ? this._paperJavaHome() : this._paperBedrockHome();
    const dir = path.join(home, id);
    if (!fs.existsSync(dir)) throw new Error(`未找到包: ${id}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const platform = home === this._paperJavaHome() ? 'java' : 'bedrock';
    return { ok: true, platform, world, id, deleted: true, note: `已删除 ${platform === 'java' ? 'Java' : '基岩'} 材质包, 重启生效` };
  }

  _paperMeta(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return {}; }
  }

  _sha1(file) {
    try {
      const crypto = require('crypto');
      const h = crypto.createHash('sha1');
      h.update(fs.readFileSync(file));
      return h.digest('hex');
    } catch { return ''; }
  }

  /** 从 zip 探测平台: manifest.json -> bedrock; pack.mcmeta(+data) -> datapack; pack.mcmeta(+assets) -> resource-java */
  _paperProbeType(zipFile, stagingRoot) {
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (fs.existsSync(path.join(dir, e.name, 'manifest.json'))) return 'bedrock';
        if (fs.existsSync(path.join(dir, e.name, 'pack.mcmeta'))) {
          const sub = fs.readdirSync(path.join(dir, e.name));
          if (sub.includes('data')) return 'datapack';
          return 'resource-java';
        }
        const r = walk(path.join(dir, e.name));
        if (r) return r;
      }
      return '';
    };
    // 顶层文件也可能是包
    try {
      const tops = fs.readdirSync(stagingRoot);
      if (tops.includes('manifest.json')) return 'bedrock';
      if (tops.includes('pack.mcmeta')) {
        if (tops.includes('data')) return 'datapack';
        return 'resource-java';
      }
    } catch {}
    return walk(stagingRoot);
  }

  /** paper 安装: type=datapack(装世界) | resource-java(库) | resource-bedrock(库); type 空则自动探测 */
  _paperInstall(zipFile, type, world) {
    const staging = path.join(this.worldDir, `.packs_staging_paper_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      this._extractZip(zipFile, staging);
      let t = type;
      if (t === 'resource') t = 'auto';          // 旧面板兼容: 自动探测
      if (t === 'behavior') t = 'datapack';      // 旧面板兼容: 行为包 -> Java 数据包
      if (!t || t === 'auto') t = this._paperProbeType(zipFile, staging);
      if (t === 'bedrock') {
        // 校验: 基岩材质包须含 manifest.json (data模块=行为addon 拒绝)
        const root = this._findManifestRoot(staging);
        if (!root) throw new Error('基岩包必须为纯材质包(resources), 行为包(addon)不支持与 Java 互通');
        return this._paperStoreBedrockFromFile(zipFile);
      }
      if (t === 'datapack') {
        if (!world) throw new Error('数据包需指定世界 (world)');
        const packRoot = this._findMcmetaRoot(staging);
        if (!packRoot) throw new Error('Java 数据包缺少 pack.mcmeta');
        return this._paperInstallDatapack(world, staging, packRoot);
      }
      if (t === 'resource-java') {
        const packRoot = this._findMcmetaRoot(staging);
        if (!packRoot) throw new Error('Java 材质包缺少 pack.mcmeta');
        return this._paperStoreJava(staging, packRoot, zipFile);
      }
      throw new Error('无法识别包类型 (需 manifest.json 或 pack.mcmeta), 基岩行为包(addon)不支持互通');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  _findManifestRoot(staging) {
    // 返回含 manifest.json 的目录 (只接受 data/resources 模块 = 材质包; 行为 addon 拒绝)
    const walk = (dir, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      if (entries.some(e => e.name === 'manifest.json')) {
        const mf = this._readManifest(dir);
        const types = mf?.moduleTypes || [];
        if (types.includes('resources')) return dir;      // 纯材质 → 允许
        if (types.includes('data')) return 'ADDON';        // 行为 → 标记拒绝
        return dir;                                        // 无 modules → 按材质收(宽松)
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === '__MACOSX') continue;
        const r = walk(path.join(dir, e.name), depth + 1);
        if (r) return r;
      }
      return null;
    };
    const r = walk(staging, 0);
    return r === 'ADDON' ? null : r;
  }

  _findMcmetaRoot(staging) {
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      if (entries.some(e => e.name === 'pack.mcmeta')) return dir;
      for (const e of entries) {
        if (!e.isDirectory() || e.name === '__MACOSX') continue;
        const r = walk(path.join(dir, e.name));
        if (r) return r;
      }
      return null;
    };
    return walk(staging);
  }

  /** 把 staging 中某个包目录内容搬到 dest (去垃圾) */
  _movePackContents(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      if (f === '__MACOSX' || f === '.DS_Store' || f.startsWith('._')) continue;
      try { fs.renameSync(path.join(src, f), path.join(dest, f)); }
      catch { fs.cpSync(path.join(src, f), path.join(dest, f), { recursive: true }); }
    }
  }

  _paperStoreJava(staging, packRoot, zipFile) {
    const mfRaw = path.join(packRoot, 'pack.mcmeta');
    let name = 'java_pack';
    try { const j = JSON.parse(fs.readFileSync(mfRaw, 'utf8')); name = (j.pack && j.pack.description) || 'java_pack'; } catch {}
    const id = this._paperGenId('java');
    const dest = path.join(this._paperJavaHome(), id);
    fs.mkdirSync(dest, { recursive: true });
    // 保留原始 zip (URL 直接下发用)
    const ext = path.extname(zipFile) || '.zip';
    const file = `pack${ext}`;
    fs.copyFileSync(zipFile, path.join(dest, file));
    fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify({
      name: String(name).slice(0, 60), file, platform: 'java',
      addedAt: Date.now(), originalName: path.basename(zipFile),
    }, null, 2), 'utf8');
    return { ok: true, platform: 'java', uuid: id, id, name: String(name).slice(0, 60), file,
      note: 'Java 材质包已上传组件库, 请到「材质包」启用 (仅 Java 玩家), 重启生效' };
  }

  _paperStoreBedrockFromFile(zipFile) {
    // 直接保存上传的原始 .mcpack/.zip (Geyser URL 下发需原包)
    const file = 'pack.mcpack';  // 固定 ASCII 文件名, URL 下发安全
    let name = 'bedrock_pack';
    try {
      const staging = path.join(this.worldDir, `.probe_${Date.now()}_${Math.floor(Math.random()*1e6)}`);
      fs.mkdirSync(staging, { recursive: true });
      this._extractZip(zipFile, staging);
      const root = this._findManifestRoot(staging);
      if (root) { const mf = this._readManifest(root); if (mf && mf.headerName) name = String(mf.headerName).slice(0,60); }
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {}
    const id = this._paperGenId('bedrock');
    const dest = path.join(this._paperBedrockHome(), id);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(zipFile, path.join(dest, file));
    fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify({
      name, file, platform: 'bedrock', addedAt: Date.now(), originalName: path.basename(zipFile),
    }, null, 2), 'utf8');
    return { ok: true, platform: 'bedrock', uuid: id, id, name, file,
      note: '基岩材质包已上传组件库, 请到「材质包」启用 (Geyser 推送给基岩玩家), 重启生效' };
  }

  _paperInstallDatapack(world, staging, packRoot) {
    const root = this._worldRoot(world);
    const dpDir = path.join(root, 'datapacks');
    fs.mkdirSync(dpDir, { recursive: true });
    let base = path.basename(packRoot);
    if (base === '.' || base === path.basename(staging)) base = 'datapack';
    const id = this._sanitize(base) + (fs.existsSync(path.join(dpDir, this._sanitize(base))) ? '_' + Date.now().toString(36) : '');
    const dest = path.join(dpDir, id);
    this._movePackContents(packRoot, dest);
    return { ok: true, platform: 'datapack', world, uuid: id, id, name: id,
      note: 'Java 数据包已装入世界 datapacks/, 双端生效 (重启或 /reload)' };
  }

  /** 简易 zip 目录 (node 无内置, 用系统 zip; fallback tar 不行 → 依赖 unzip/zip 已装) */
  _zipDir(srcDir, outZip) {
    const { execFileSync } = require('child_process');
    fs.rmSync(outZip, { force: true });
    // zip -r outZip . (cwd=srcDir) — 服务器有 zip? 无则用 tar 不行; 用 python zipfile 更稳
    try { execFileSync('zip', ['-rq', outZip, '.'], { cwd: srcDir }); return; } catch {}
    // fallback: python3 -m zipfile
    try {
      execFileSync('python3', ['-c', `import zipfile,os,sys; src='${srcDir}'; out='${outZip}'; z=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED); [z.write(os.path.join(r,f), os.path.relpath(os.path.join(r,f),src)) for r,_,fs in os.walk(src) for f in fs]; z.close()`], { timeout: 60000 });
    } catch (e) { throw new Error('打包 mcpack 失败: ' + e.message); }
  }



}

module.exports = Packs;
