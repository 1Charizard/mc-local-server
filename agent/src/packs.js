// 世界行为包/材质包管理: 列表/启停/删除/从 zip 安装 (按世界隔离)
// 机制: 包文件放 <世界>/behavior_packs/<包>/ 与 <世界>/resource_packs/<包>/
//       激活状态由 <世界>/world_behavior_packs.json / world_resource_packs.json 记录 [{pack_id, version}]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class Packs {
  constructor(bdsCfg, bds) {
    this.cfg = bdsCfg;
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

  // ---------- 核心 API ----------

  /** 列出某世界的包: { behavior:[], resource:[] } (含启用状态) */
  list(world) {
    const root = this._worldRoot(world);
    const out = { world, behavior: [], resource: [] };
    // 读取当前激活 json (可能不存在 -> 空)
    const activeBehavior = new Set(this._readJsonArray(path.join(root, 'world_behavior_packs.json')).map(x => x.pack_id));
    const activeResource = new Set(this._readJsonArray(path.join(root, 'world_resource_packs.json')).map(x => x.pack_id));

    const scan = (relDir, type, list, activeSet) => {
      const dir = path.join(root, relDir);
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pdir = path.join(dir, entry.name);
        const mf = this._readManifest(pdir);
        const name = mf ? this._localizedName(pdir, mf.headerName || entry.name) : entry.name;
        const uuid = mf ? mf.uuid : '';
        const version = mf ? mf.version : [1, 0, 0];
        list.push({
          uuid,
          folder: entry.name,
          name,
          version: Array.isArray(version) ? version.join('.') : String(version),
          type,
          size: this._dirSizeSync(pdir),
          enabled: uuid ? activeSet.has(uuid) : activeSet.has(entry.name),
          hasManifest: !!mf,
        });
      }
    };

    scan('behavior_packs', 'behavior', out.behavior, activeBehavior);
    scan('resource_packs', 'resource', out.resource, activeResource);
    return out;
  }

  /** 按 uuid 或文件夹名找到包 (遍历两类) */
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

  /** 启用/停用某世界的包 (改 world_*_packs.json) */
  toggle(world, uuid, enabled) {
    const root = this._worldRoot(world);
    const found = this._findPack(root, uuid);
    if (!found) throw new Error(`未找到该包 (uuid=${uuid})`);
    const type = found.type;
    const relFile = type === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json';
    const file = path.join(root, relFile);
    const arr = this._readJsonArray(file);
    const version = found.mf ? found.mf.version : [1, 0, 0];

    if (enabled) {
      if (!arr.some(x => x.pack_id === found.mf?.uuid)) {
        arr.push({ pack_id: found.mf?.uuid || found.folder, version });
        this._writeJsonArray(file, arr);
      }
      return { ok: true, world, type, folder: found.folder, enabled: true, note: '包已启用, 重启世界后生效' };
    }
    const filtered = arr.filter(x => x.pack_id !== found.mf?.uuid && x.pack_id !== found.folder);
    if (filtered.length !== arr.length) {
      this._writeJsonArray(file, filtered);
    }
    return { ok: true, world, type, folder: found.folder, enabled: false, note: '包已停用, 重启世界后生效' };
  }

  /** 删除包 (停用 + 删目录) */
  remove(world, uuid) {
    const root = this._worldRoot(world);
    const found = this._findPack(root, uuid);
    if (!found) throw new Error(`未找到该包 (uuid=${uuid})`);
    // 先停用
    this.toggle(world, uuid, false);
    fs.rmSync(found.dir, { recursive: true, force: true });
    return { ok: true, world, folder: found.folder, deleted: true };
  }

  /** 从已解压 staging 中识别包 (含 staging 根自身 + 收集含 manifest.json 的目录, 排除父链也有 manifest 的嵌套) */
  _discoverPacks(staging) {
    const hits = [];
    // staging 根自身就是包 (zip 根 = manifest.json)
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
          continue; // 不再深入 (manifest 包内部不再嵌套包)
        }
        // 若含 level.dat 说明是整个世界, 跳过 (避免把世界当包)
        if (fs.existsSync(path.join(full, 'level.dat'))) continue;
        walk(full);
      }
    };
    walk(staging);
    return hits;
  }

  /** 判断包类型: 指定 > manifest modules > 路径 > 特征; 返回 'behavior'|'resource' */
  _detectType(packDir, forced, staging) {
    if (forced === 'behavior' || forced === 'resource') return forced;
    const mf = this._readManifest(packDir);
    if (mf && mf.moduleTypes.includes('data')) return 'behavior';
    if (mf && mf.moduleTypes.includes('resources')) return 'resource';
    // 路径线索
    const rel = path.relative(staging, packDir).replace(/\\/g, '/');
    if (/behavior_packs\//.test(rel)) return 'behavior';
    if (/resource_packs\//.test(rel)) return 'resource';
    // 目录特征
    try {
      const names = fs.readdirSync(packDir).join(' ');
      if (/\b(textures|models|texts|sounds|ui|render_controllers|materials)\b/.test(names)) return 'resource';
      if (/\b(scripts|blocks|entities|items|recipes|spawn_rules)\b/.test(names)) return 'behavior';
    } catch {}
    throw new Error('无法识别包类型 (manifest 无 modules, 请手动指定 行为包/材质包)');
  }

  /** 从 zip 安装包到世界 (支持多个包; forcedType 可选) */
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
        // 目标文件夹名: 原文件夹名(清理); zip 根即包时用 header.name
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
        const name = mf ? this._localizedName(dest, mf.headerName || base) : base;
        installed.push({ folder: path.basename(dest), name, uuid, type, version: mf?.version?.join('.') || '1.0.0', enabled: true });
      }
      return { ok: true, world, installed };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** 内置 zip 解压 (zlib + central directory; 免系统 unzip; 防 zip-slip) — 与 worlds.js 同逻辑 */
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
