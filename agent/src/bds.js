// BDS 进程管理: 启停/重启/崩溃自愈/stdin 指令
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

class BDS extends EventEmitter {
  constructor(cfg, { rcon }) {
    super();
    this.cfg = cfg;
    this.rcon = rcon;
    this.proc = null;
    this.running = false;
    this.pid = null;
    this._logBuffer = [];       // 环形缓冲
    this._maxLogLines = 2000;
    this._stdinQueue = Promise.resolve();
    this._crashCount = 0;
    this._version = '';
    this._lastCpu = 0; this._lastCpuTime = 0;
    this._restarting = false;
  }

  get logBuffer() { return this._logBuffer; }

  detectVersion() {
    if (this._version) return this._version;
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(this.cfg.dir, 'version.json'), 'utf8'));
      this._version = mf.version || '';
    } catch {}
    return this._version;
  }

  async start() {
    if (this.proc) return;
    this._restarting = false;
    const script = this.cfg.runScript;
    if (!fs.existsSync(script)) throw new Error(`运行脚本不存在: ${script}`);
    this._log('info', '正在启动 BDS ...');
    // run.sh 内部 cd 到 bds 目录
    this.proc = spawn('bash', [script], { cwd: this.cfg.dir, env: process.env });
    this.pid = this.proc.pid;
    this.running = true;

    this.proc.stdout.on('data', chunk => this._feed(chunk.toString()));
    this.proc.stderr.on('data', chunk => this._feed(chunk.toString()));
    this.proc.on('error', err => this._log('error', `进程错误: ${err.message}`));
    this.proc.on('exit', (code, signal) => {
      this._log('warn', `BDS 进程退出 code=${code} signal=${signal}`);
      const crashed = this.running && !this._restarting;
      this.proc = null; this.pid = null; this.running = false;
      if (crashed) {
        this._crashCount++;
        this.emit('crash', `BDS 异常退出 (code=${code}), 5 秒后自动重启 (第 ${this._crashCount} 次)`);
        this._log('warn', `崩溃自愈: 5 秒后重启 (第 ${this._crashCount} 次)`);
        setTimeout(() => { if (!this.proc) this.start().catch(e => this._log('error', `重启失败: ${e.message}`)); }, 5000);
      } else {
        this._crashCount = 0;
      }
      this.emit('stopped');
    });

    // 等待启动完成 (检测 "Server started" 日志 或超时)
    await this._waitStarted(this.cfg.startTimeoutMs || 90000);
    this.emit('started');
  }

  _waitStarted(timeoutMs) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (this._logBuffer.some(l => l.includes('Server started') || l.includes('IPv6 supported'))) {
          clearInterval(timer); resolve();
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer); resolve(); // 超时视为已启动(部分版本日志不同)
        }
      }, 500);
    });
  }

  async stop() {
    if (!this.proc) return;
    this._restarting = true;
    this._log('info', '正在停止 BDS ...');
    try {
      // 先广播, 再优雅停止
      await this.rcon.exec('say §c服务器即将关闭...');
      await this.rcon.exec('save hold');
    } catch {}
    try { await this.rcon.exec('stop'); } catch {}
    // 等待退出, 最长 30s
    const t0 = Date.now();
    while (this.proc && Date.now() - t0 < 30000) await new Promise(r => setTimeout(r, 200));
    if (this.proc) {
      this._log('warn', 'BDS 未在 30s 内退出, 强制终止');
      try { this.proc.kill('SIGKILL'); } catch {}
    }
    this._restarting = false;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  /** 向 BDS stdin 发送指令 (仅作为 RCON 兜底) */
  sendStdin(cmd) {
    if (!this.proc || !this.proc.stdin) throw new Error('BDS 未运行');
    this._stdinQueue = this._stdinQueue.then(() => new Promise(res => {
      try { this.proc.stdin.write(cmd + '\n', res); } catch { res(); }
    }));
  }

  _feed(text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      this._logBuffer.push(line);
      if (this._logBuffer.length > this._maxLogLines) this._logBuffer.shift();
      this.emit('log', line);
    }
  }

  _log(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    this._feed(line);
  }
}

module.exports = BDS;
