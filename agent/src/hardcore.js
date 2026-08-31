// MC1life 真·硬核模式: 监控 BDS 日志, 玩家死亡即触发动作
// 模式:
//   ban  - 封禁死亡玩家 (死亡一次永久踢出, 服务器继续)
//   wipe - 删档重开 (先备份 -> 停止服务器 -> 删除当前世界 -> 重新生成, 最硬核)
// 注意: 基岩版 BDS 无官方 hardcore, 这是通过日志监控实现的近似方案。
const path = require('path');
const fs = require('fs');

// 基岩版 BDS 玩家死亡日志模式 (多版本兼容)
const DEATH_RE =
  /^\[.*?\]\s*(?:INFO|WARN)\s*\](?:\s+)?(.+?)\s+(died|was slain|was killed|was shot|was blown|was pricked|was fireballed|was impaled|was squashed|was struck by lightning|was stung|was poked|was skewered|was flattened|was doomed|was smited|was scorched|was roasted|was fried|was electrocuted|was dragged into the void|was thrown into the void|fell out of the world|fell from a high place|fell off|suffocated|drowned|burned to death|tried to swim in lava|tried to fly with elytra|starved to death|blew up|hit the ground too hard|went up in flames|froze to death|experienced kinetic energy|was killed while trying to hurt|was killed by the intended death mechanics|was killed by \[)/i;

class Hardcore {
  /**
   * @param {object} cfg - config.hardcore { enabled, mode }
   * @param {object} deps - { bds, rcon, backup, send }
   */
  constructor(cfg, { bds, rcon, backup, send }) {
    this.cfg = cfg || {};
    this.bds = bds;
    this.rcon = rcon;
    this.backup = backup;
    this.send = send;
    this._lastLine = '';
    this._pendingWipe = false;
  }

  start() {
    if (!this.cfg.enabled) return;
    console.log(`[MC1life] 硬核模式已启用: mode=${this.cfg.mode}`);
    this.bds.on('log', line => this._onLog(line));
  }

  /** 热更新配置 (面板开关) */
  update(cfg) {
    const wasEnabled = !!this.cfg.enabled;
    this.cfg = { ...this.cfg, ...cfg };
    console.log(`[MC1life] 硬核配置更新: enabled=${this.cfg.enabled} mode=${this.cfg.mode}`);
    // 之前开着现在关了 -> 移除监听 (无法移除, 用标志位)
    // 之前关着现在开了 -> 补监听
    if (!wasEnabled && this.cfg.enabled) {
      console.log('[MC1life] 硬核模式已启用 (热更新)');
    }
  }

  _onLog(line) {
    if (!this.cfg.enabled) return;
    if (this._pendingWipe) return;
    if (!line) return;
    const m = line.match(DEATH_RE);
    if (!m) return;
    const player = m[1].trim();
    if (line === this._lastLine) return;
    this._lastLine = line;

    console.log(`[MC1life] ⚠️ 检测到死亡: ${player} | ${line}`);
    this.send('hardcore', { action: this.cfg.mode, player, line });
    if (this.cfg.mode === 'ban') {
      this._ban(player).catch(e => console.error('[MC1life] 硬核封禁失败', e.message));
    } else {
      this._wipe(player, line).catch(e => console.error('[MC1life] 硬核删档失败', e.message));
    }
  }

  async _ban(player) {
    this._pendingWipe = true;
    try {
      await this.rcon.exec(`say §4☠ ${player} 已死亡, 硬核模式: 永久封禁`);
      await new Promise(r => setTimeout(r, 500));
      await this.rcon.exec(`ban "${player}" §4硬核死亡 (MC1life)`);
      await this.rcon.exec(`kick "${player}" §4硬核死亡, 再见`);
      await this.send('hardcore', { action: 'ban', player, ok: true });
    } finally {
      setTimeout(() => { this._pendingWipe = false; }, 5000);
    }
  }

  async _wipe(player, line) {
    this._pendingWipe = true;
    try {
      const bdsCfg = this.bds.cfg;
      await this.send('hardcore', { action: 'wipe', player, line, phase: 'starting' });

      // 1. 死亡前备份 (防丢档, 可恢复)
      await this.send('hardcore', { action: 'wipe', player, phase: 'backup' });
      let backupId = null;
      try {
        const bk = await this.backup.create(`pre-death-${player.replace(/[^a-zA-Z0-9_-]/g, '')}`);
        backupId = bk?.id || bk?.backupId || null;
        console.log(`[MC1life] 死亡前备份完成: ${backupId || 'unknown'}`);
      } catch (e) {
        console.error('[MC1life] 死亡前备份失败, 继续删档:', e.message);
      }

      // 2. 通知 + 优雅停止
      await this.send('hardcore', { action: 'wipe', player, phase: 'stopping', backupId });
      await this.rcon.exec('say §c☠ 玩家死亡! 硬核模式: 世界即将重置...').catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
      console.log('[MC1life] 硬核删档: 停止 BDS...');
      await this.bds.stop();

      // 3. 删除当前世界
      let worldName = 'Bedrock level';
      try {
        const sp = fs.readFileSync(path.join(bdsCfg.dir, 'server.properties'), 'utf8');
        const m = sp.match(/^level-name=(.*)$/m);
        if (m) worldName = m[1].trim();
      } catch {}
      const worldDir = path.join(bdsCfg.dir, 'worlds', worldName);
      console.log(`[MC1life] 硬核删档: 删除世界 ${worldDir}`);
      if (fs.existsSync(worldDir)) {
        fs.rmSync(worldDir, { recursive: true, force: true });
      }
      await this.send('hardcore', { action: 'wipe', player, world: worldName, phase: 'deleted', backupId });

      // 4. 重启生成新世界
      console.log('[MC1life] 硬核删档: 重新启动 BDS (新世界)...');
      await this.bds.start();
      await this.send('hardcore', { action: 'wipe', player, world: worldName, phase: 'restarted', backupId, ok: true });
      console.log('[MC1life] 硬核删档完成, 新世界已生成');
    } finally {
      this._pendingWipe = false;
    }
  }
}

module.exports = Hardcore;
