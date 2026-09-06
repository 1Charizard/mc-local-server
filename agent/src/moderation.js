// 封禁管理: bans.json 封禁库 + allowlist.json 白名单同步 (真封禁需 allow-list=true)
// 永久/限时封禁、封禁列表、解封、改时间、到期自动解封、玩家 xuid 捕获缓存
const fs = require('fs');
const path = require('path');

class Moderation {
  constructor(bdsCfg, bds, rcon) {
    this.bdsCfg = bdsCfg;
    this.bds = bds;
    this.rcon = rcon; // { exec }
    this.rootDir = path.resolve(bdsCfg.dir, '..');           // /opt/mc1life
    this.bansPath = path.join(this.rootDir, 'bans.json');
    this.cachePath = path.join(this.rootDir, 'players_cache.json');
    this.allowlistPath = path.join(bdsCfg.dir, 'allowlist.json');
    this.propsPath = path.join(bdsCfg.dir, 'server.properties');
    this.bans = [];       // [{name, xuid, reason, until(null=永久), bannedAt}]
    this.cache = {};      // { [name]: {name, xuid, lastSeen} }
    this._expireTimer = null;
  }

  // ---------- 持久化 ----------
  _readJson(file, def) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? def; } catch { return def; }
  }
  _writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }
  _loadBans() { this.bans = Array.isArray(this._readJson(this.bansPath, [])) ? this._readJson(this.bansPath, []) : []; }
  _saveBans() { this._writeJson(this.bansPath, this.bans); }
  _loadCache() {
    const c = this._readJson(this.cachePath, {});
    if (c && typeof c === 'object') this.cache = c;
  }
  _saveCache() { this._writeJson(this.cachePath, this.cache); }

  _readProps() {
    const map = {};
    try {
      for (const line of fs.readFileSync(this.propsPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) map[m[1].trim()] = m[2].trim();
      }
    } catch {}
    return map;
  }

  allowListEnabled() {
    const props = this._readProps();
    return String(props['allow-list'] || props['allow-listed-players-only'] || 'false').toLowerCase() === 'true';
  }

  // ---------- allowlist.json 读写 ----------
  _readAllowlist() {
    return Array.isArray(this._readJson(this.allowlistPath, [])) ? this._readJson(this.allowlistPath, []) : [];
  }
  _saveAllowlist(arr) { this._writeJson(this.allowlistPath, arr); }
  _reloadAllowlist() {
    // 尽力热加载 (命令存在则执行, 失败静默)
    return this.rcon.exec('allowlist reload', 8000).catch(() => '');
  }

  /** 从 allowlist 移除 (按 xuid 或 name) */
  removeFromAllowlist(entry) {
    const arr = this._readAllowlist();
    const before = arr.length;
    const filtered = arr.filter(x => {
      const xu = String(x.xuid || '');
      const nm = String(x.name || '');
      return !((entry.xuid && xu === String(entry.xuid)) || (entry.name && nm.toLowerCase() === String(entry.name).toLowerCase()));
    });
    if (filtered.length !== before) {
      this._saveAllowlist(filtered);
      this._reloadAllowlist();
      return true;
    }
    return false;
  }

  /** 添加白名单条目 (name+xuid) */
  addToAllowlist(name, xuid) {
    if (!name || !xuid) return { ok: false, error: '缺少 name/xuid' };
    const arr = this._readAllowlist();
    if (arr.some(x => String(x.xuid || '') === String(xuid) || String(x.name || '').toLowerCase() === String(name).toLowerCase())) {
      return { ok: true, existed: true };
    }
    arr.push({ ignoresPlayerLimit: false, name: String(name).slice(0, 40), xuid: String(xuid) });
    this._saveAllowlist(arr);
    this._reloadAllowlist();
    return { ok: true, added: true };
  }

  // ---------- 玩家缓存 (xuid 捕获) ----------
  recordPlayer(name, xuid) {
    if (!name) return;
    const prev = this.cache[name];
    if (prev && prev.xuid && !xuid) return;
    if (!prev || prev.xuid !== xuid || !prev.lastSeen) {
      this.cache[name] = { name, xuid: xuid || prev?.xuid || '', lastSeen: Date.now() };
      this._saveCache();
    }
  }
  findXuid(nameOrXuid) {
    if (/^\d{10,20}$/.test(String(nameOrXuid))) return String(nameOrXuid);
    return this.cache[nameOrXuid]?.xuid || '';
  }
  /** 从 permissions.json 合并 operator (可能只有 xuid) */
  knownOperators() {
    const perms = this._readJson(path.join(this.bdsCfg.dir, 'permissions.json'), []);
    return (Array.isArray(perms) ? perms : []).filter(p => p && p.xuid);
  }

  // ---------- 核心 API ----------

  /** 踢出在线玩家 (带理由) */
  async kick(name, reason) {
    if (!name) throw new Error('缺少玩家名');
    const reasonText = String(reason || '').slice(0, 100);
    const out = await this.rcon.exec(`kick "${name.trim()}" ${reasonText ? '你已被管理员移出: ' + reasonText : '你已被管理员移出'}`, 8000);
    const ok = !/error|no targets|unknown|not found/i.test(String(out));
    if (ok) this._log(`踢出玩家: ${name.trim()}${reasonText ? ' (' + reasonText + ')' : ''}`);
    return { ok, kicked: ok, output: String(out).slice(0, 300) };
  }

  init() {
    this._loadBans();
    this._loadCache();
    // 开启白名单时, 自动把已知 OP 与缓存过 xuid 的玩家加白 (防止服主/老玩家被锁外)
    try { this._seedAllowlist(); } catch (e) { this._log('白名单种子化失败: ' + e.message); }
    // 监听 BDS 日志: 捕获玩家连接 xuid; allowlist 拒绝自动加白/拦截封禁
    this.bds.on('log', (line) => this._onLogLine(String(line)));
    // 到期扫描 (每 30s)
    this._expireTimer = setInterval(() => { try { this._scanExpired(); } catch {} }, 30000);
    // 上报状态
    this._log(`封禁系统就绪: ${this.bans.length} 条封禁, allow-list=${this.allowListEnabled() ? 'ON' : 'OFF'}`);
    return this;
  }

  /** 种子白名单: allow-list=true 时, 把已知 OP 与缓存过 xuid 的玩家加入白名单 */
  _seedAllowlist() {
    if (!this.allowListEnabled()) return;
    const entries = this._readAllowlist();
    const bannedXuids = new Set(this.bans.filter(b => b.xuid).map(b => b.xuid));
    const known = [];
    const seen = new Set();
    for (const op of this.knownOperators()) {
      if (!op.xuid || seen.has(String(op.xuid))) continue;
      seen.add(String(op.xuid));
      known.push({ name: String(op.name || `xuid_${String(op.xuid).slice(-6)}`).slice(0, 40), xuid: String(op.xuid) });
    }
    for (const [name, rec] of Object.entries(this.cache)) {
      if (!rec || !rec.xuid || seen.has(String(rec.xuid))) continue;
      seen.add(String(rec.xuid));
      known.push({ name: String(name).slice(0, 40), xuid: String(rec.xuid) });
    }
    let added = 0;
    for (const k of known) {
      if (bannedXuids.has(k.xuid)) continue;
      if (entries.some(e => String(e.xuid || '') === k.xuid)) continue;
      try {
        const r = this.addToAllowlist(k.name, k.xuid);
        if (r.ok) added++;
      } catch {}
    }
    if (added) this._log(`白名单种子化: ${added} 个已知玩家已加白 (allow-list=ON)`);
  }

  _onLogLine(line) {
    // 1) 玩家连接: Player connected: NAME, xuid: XUID
    const conn = line.match(/Player connected: (.+?),\s*xuid:\s*(\d+)/i);
    if (conn) { this.recordPlayer(conn[1].trim(), conn[2]); return; }
    // 2) 玩家断开 (带 xuid 时也记录)
    const disc = line.match(/Player disconnected: (.+?),\s*xuid:\s*(\d+)/i);
    if (disc) { this.recordPlayer(disc[1].trim(), disc[2]); return; }
    // 3) allowlist 拒绝: Player NAME (xuid: XUID) ... not on the allowlist / not in the allowlist
    if (/allowlist/i.test(line) && /(not on|not in|isn'?t on|remove)/i.test(line)) {
      const m = line.match(/Player\s+(.+?)(?:\s*\(xuid:\s*(\d+)\))?.*(?:disconnected|refused|denied|kick)/i) ||
                line.match(/Player\s+(.+?)(?:\s*\(xuid:\s*(\d+)\))/i);
      if (m) {
        const name = m[1].trim().replace(/[^ -~]+$/, '');
        const xuid = m[2] || '';
        this.recordPlayer(name, xuid);
        // 若为封禁玩家 → 保持拒绝 (不加白); 否则自动加白 (首次需重连)
        const banned = this.bans.some(b =>
          (b.xuid && b.xuid === xuid) || (!xuid && b.name && b.name.toLowerCase() === name.toLowerCase()));
        if (banned) {
          this._log(`已拦截封禁玩家连接: ${name}${xuid ? ' (xuid ' + xuid + ')' : ''}`);
        } else if (xuid) {
          this.addToAllowlist(name, xuid);
          this._log(`自动加白: ${name} (xuid ${xuid}), 请重连进入`);
        }
      }
    }
  }

  /** 计算封禁状态 (含剩余时间) */
  _decorate(b) {
    const now = Date.now();
    let status, remainingMs = null;
    if (!b.until) { status = 'permanent'; }
    else if (b.until <= now) { status = 'expired'; }
    else { status = 'temporary'; remainingMs = b.until - now; }
    return { ...b, status, remainingMs };
  }

  /** 封禁列表 (含状态) */
  list() {
    const now = Date.now();
    return this.bans
      .map(b => {
        const d = this._decorate(b);
        return {
          name: b.name,
          xuid: b.xuid || '',
          reason: b.reason || '',
          bannedAt: b.bannedAt,
          until: b.until || null,           // null=永久
          status: d.status,                  // permanent | temporary | expired
          remainingMs: d.remainingMs,
        };
      })
      .sort((a, b) => (b.bannedAt || 0) - (a.bannedAt || 0));
  }

  /** 封禁: name 必填; until=null 永久, 数值=到期时间戳; 在线玩家立即踢出 */
  async ban(name, opts = {}) {
    if (!name || typeof name !== 'string') throw new Error('缺少玩家名');
    const reason = String(opts.reason || '').slice(0, 200);
    let until = opts.until === undefined || opts.until === null || opts.until === '' ? null : Number(opts.until);
    if (until !== null && (!Number.isFinite(until) || until < Date.now())) {
      throw new Error('封禁到期时间无效 (需为未来时间戳, 永久请传 null)');
    }
    // 查找缓存 xuid
    const xuid = this.findXuid(name.trim());
    if (xuid) this.recordPlayer(name.trim(), xuid);
    // 已存在则更新
    const idx = this.bans.findIndex(b =>
      (b.xuid && xuid && b.xuid === xuid) || (b.name && b.name.toLowerCase() === name.trim().toLowerCase()));
    const rec = { name: name.trim(), xuid: xuid || '', reason, until, bannedAt: Date.now() };
    if (idx >= 0) this.bans[idx] = { ...this.bans[idx], ...rec };
    else this.bans.push(rec);
    this._saveBans();

    // 从白名单移除 (allow-list=true 时生效阻止重连)
    this.removeFromAllowlist(rec);
    // 在线则踢出 (kick 命令存在)
    let kicked = false;
    try {
      const out = await this.rcon.exec(`kick "${name.trim()}" 你已被封禁${reason ? ': ' + reason : ''}${until ? '' : ' (永久)'}`, 8000);
      kicked = !/error|no targets|unknown/i.test(String(out));
    } catch {}
    // 日志
    const d = this._decorate(rec);
    this._log(`封禁: ${rec.name}${xuid ? ' (xuid ' + xuid + ')' : ''} ${d.status === 'permanent' ? '永久' : '至 ' + new Date(until).toLocaleString('zh-CN')} ${reason ? '原因: ' + reason : ''}${kicked ? ' [已踢出]' : ''}`);
    return { ok: true, banned: this._decorate(rec), kicked };
  }

  /** 解封: name 或 xuid */
  unban(nameOrXuid) {
    if (!nameOrXuid) throw new Error('缺少玩家标识');
    const key = String(nameOrXuid).trim();
    const before = this.bans.length;
    const matched = this.bans.filter(b =>
      (b.name && b.name.toLowerCase() === key.toLowerCase()) || (b.xuid && b.xuid === key));
    this.bans = this.bans.filter(b =>
      !((b.name && b.name.toLowerCase() === key.toLowerCase()) || (b.xuid && b.xuid === key)));
    if (this.bans.length === before) throw new Error(`未找到封禁记录: ${key}`);
    this._saveBans();
    // 若知道 xuid 则加回白名单 (allow-list 模式)
    for (const b of matched) {
      if (b.xuid) {
        try { this.addToAllowlist(b.name || key, b.xuid); } catch {}
      }
    }
    this._log(`解封: ${matched.map(b => b.name || b.xuid).join(', ')}`);
    return { ok: true, unbanned: matched.map(b => ({ name: b.name, xuid: b.xuid })) };
  }

  /** 修改封禁时间: until=null 永久 | 时间戳 限时 | 0 立即到期(=解封走 unban) */
  setTime(nameOrXuid, until) {
    if (!nameOrXuid) throw new Error('缺少玩家标识');
    const key = String(nameOrXuid).trim();
    const rec = this.bans.find(b =>
      (b.name && b.name.toLowerCase() === key.toLowerCase()) || (b.xuid && b.xuid === key));
    if (!rec) throw new Error(`未找到封禁记录: ${key}`);
    if (until !== null && until !== undefined) {
      const t = Number(until);
      if (!Number.isFinite(t) || (t !== 0 && t < Date.now())) throw new Error('到期时间无效');
      rec.until = t === 0 ? Date.now() : t;
    } else {
      rec.until = null; // 永久
    }
    this._saveBans();
    const d = this._decorate(rec);
    this._log(`修改封禁时间: ${rec.name} -> ${d.status === 'permanent' ? '永久' : '至 ' + new Date(rec.until).toLocaleString('zh-CN')}`);
    return { ok: true, banned: d };
  }

  /** 到期自动解封 */
  _scanExpired() {
    const now = Date.now();
    const expired = this.bans.filter(b => b.until && b.until <= now);
    if (!expired.length) return;
    for (const b of expired) {
      if (b.xuid) { try { this.addToAllowlist(b.name, b.xuid); } catch {} }
      this._log(`封禁到期自动解封: ${b.name}${b.xuid ? ' (xuid ' + b.xuid + ')' : ''}`);
    }
    this.bans = this.bans.filter(b => !(b.until && b.until <= now));
    this._saveBans();
  }

  _log(msg) { console.log(`[MC1life] ${msg}`); }
}

module.exports = Moderation;
