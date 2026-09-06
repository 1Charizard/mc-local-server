// 玩家死亡自动备份 (个人数据保护): 监听 BDS 日志, 玩家死亡即自动备份整个世界的"死亡瞬间快照"
// 快照含该玩家的 LevelDB 记录 (背包/血量/Buff/坐标/末影箱/进度/基地建筑), 用于死亡后恢复
// 与硬核模式(极限)互相独立: 可单独开启/关闭 (config.deathBackup.enabled / 面板开关)
// 说明: 基岩版 BDS 玩家数据存于世界 LevelDB, 无法只导出单玩家 → 采用世界级一致性快照
const path = require('path');
const fs = require('fs');

// 基岩版 BDS 玩家死亡日志模式 (与 hardcore.js 同步维护)
// 真实日志头形如: [2026-09-07 05:00:00:000 INFO] Alice fell from a high place
const DEATH_RE =
  /^\[[^\]]*\]\s*(.+?)\s+(died|was slain|was killed|was shot|was blown|was pricked|was fireballed|was impaled|was squashed|was struck by lightning|was stung|was poked|was skewered|was flattened|was doomed|was smited|was scorched|was roasted|was fried|was electrocuted|was dragged into the void|was thrown into the void|fell out of the world|fell from a high place|fell off|suffocated|drowned|burned to death|tried to swim in lava|tried to fly with elytra|starved to death|blew up|hit the ground too hard|went up in flames|froze to death|experienced kinetic energy|was killed while trying to hurt|was killed by the intended death mechanics|was killed by \[)/i;

class DeathWatch {
  /**
   * @param {object} cfg - config.deathBackup { enabled, keepPerPlayer, keepGlobal }
   * @param {object} deps - { bds, backup, shared } shared.lastDeath 供 hardcore wipe 复用避免双份
   */
  constructor(cfg, { bds, backup, shared }) {
    this.cfg = cfg || { enabled: true, keepPerPlayer: 3, keepGlobal: 30 };
    this.bds = bds;
    this.backup = backup;
    this.shared = shared || { lastDeath: null };
    this._lastLine = '';
    this._cooldown = {}; // player -> ts (防死亡连锁刷备份)
    this._chain = Promise.resolve(); // 串行队列 (多人连续死亡不丢事件)
    this._listening = false;
  }

  start() {
    if (!this.cfg.enabled) {
      console.log('[MC1life] 死亡自动备份: OFF (可在面板/设置开启)');
      return;
    }
    this._listen();
    console.log(`[MC1life] 死亡自动备份: ON (每玩家保留 ${this.cfg.keepPerPlayer} 份, 全局上限 ${this.cfg.keepGlobal})`);
  }

  /** 热更新 (面板开关) */
  update(cfg) {
    const wasEnabled = !!this.cfg.enabled;
    this.cfg = { ...this.cfg, ...(cfg || {}) };
    this._syncBackupCfg();
    if (!wasEnabled && this.cfg.enabled) {
      this._listen();
      console.log('[MC1life] 死亡自动备份已开启 (热更新)');
    } else if (wasEnabled && !this.cfg.enabled) {
      console.log('[MC1life] 死亡自动备份已关闭 (热更新)');
    } else {
      console.log(`[MC1life] 死亡自动备份配置更新: keepPerPlayer=${this.cfg.keepPerPlayer} keepGlobal=${this.cfg.keepGlobal}`);
    }
  }

  _syncBackupCfg() {
    // 让 backup.create 轮转参数读取最新值
    if (this.backup) {
      this.backup.cfg.deathKeepPerPlayer = this.cfg.keepPerPlayer;
      this.backup.cfg.deathKeepGlobal = this.cfg.keepGlobal;
    }
  }

  _listen() {
    if (this._listening) return;
    this._listening = true;
    this.bds.on('log', (line) => this._onLog(String(line)));
  }

  _onLog(line) {
    if (!this.cfg.enabled || !line) return;
    if (line === this._lastLine) return;
    const m = line.match(DEATH_RE);
    if (!m) return;
    this._lastLine = line;
    const player = m[1].trim();
    const reason = this._reasonOf(line);
    // 防抖: 同一玩家 60s 内只备一次
    const now = Date.now();
    if (this._cooldown[player] && now - this._cooldown[player] < 60000) return;
    this._cooldown[player] = now;
    // 若硬核 wipe 同一死亡刚备份过(20s 内), 复用避免双份
    const last = this.shared.lastDeath;
    if (last && last.player === player && now - last.ts < 20000) {
      console.log(`[MC1life] 死亡自动备份: ${player} 复用硬核备份 ${last.backupId} (避免双份)`);
      return;
    }
    // 串行队列执行 (多人连续死亡不丢事件)
    this._chain = this._chain.then(() => this._backup(player, reason, line))
      .catch(e => console.error('[MC1life] 死亡自动备份失败:', e.message));
  }

  _reasonOf(line) {
    // 死亡原因文本: 尝试截取匹配片段后的 " ... by ..." 部分, 失败用整句截断
    const s = String(line);
    const verbAt = s.search(/\s+(died|was slain|was killed|was shot|was blown|was pricked|was fireballed|was impaled|was squashed|was struck by lightning|was stung|was poked|was skewered|was flattened|was doomed|was smited|was scorched|was roasted|was fried|was electrocuted|was dragged into the void|was thrown into the void|fell out of the world|fell from a high place|fell off|suffocated|drowned|burned to death|tried to swim in lava|tried to fly with elytra|starved to death|blew up|hit the ground too hard|went up in flames|froze to death|experienced kinetic energy|was killed while trying to hurt|was killed by the intended death mechanics|was killed by \[)/);
    if (verbAt >= 0) {
      const tail = s.slice(verbAt).trim().replace(/\s*\[[^\]]*\]\s*$/, '').slice(0, 120);
      if (tail) return tail;
    }
    return String(line).slice(0, 120);
  }

  async _backup(player, reason, line) {
    const safe = player.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 40) || 'player';
    console.log(`[MC1life] ☠ 检测到死亡: ${player} — ${reason}`);
    const bk = await this.backup.create(`death-${safe}`, {
      kind: 'death', player, reason: reason || line.slice(0, 120),
    });
    this.shared.lastDeath = { player, ts: Date.now(), backupId: bk.backupId };
    console.log(`[MC1life] 死亡自动备份完成: ${player} -> ${bk.backupId} (${(bk.size / 1048576).toFixed(1)}MB)`);
    return bk;
  }
}

module.exports = DeathWatch;
