// BDS 进程管理: 启停/重启/崩溃自愈/stdin 指令 (console 通道)
// 注意: BDS 1.21.90+ 移除了 RCON, 管理命令统一走进程 stdin/stdout 控制台
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class BDS extends EventEmitter {
  constructor(cfg, { rcon }) {
    super();
    this.cfg = cfg;
    this.rcon = rcon; // 保留兼容 (RCON 可用时走 TCP; BDS 1.21.90+ 无 RCON 走 console)
    this.proc = null;
    this.running = false;
    this.pid = null;
    this._logBuffer = [];       // 环形缓冲
    this._maxLogLines = 3000;
    this._stdinQueue = Promise.resolve();
    this._crashCount = 0;
    this._version = '';
    this._lastCpu = 0; this._lastCpuTime = 0;
    this._restarting = false;
    this._active = null;         // 当前活动命令 (exec 严格串行)
    this._chain = Promise.resolve();
    this._lineBuffer = '';
    // 引擎模式: 'bds' (Bedrock 官方服, console 指令) | 'paper' (Java Paper, RCON 指令)
    this._paper = cfg.mode === 'paper';
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

  /** 向服务器控制台发命令并等待响应
   *  paper 模式: 走标准 RCON (TCP 25575)
   *  bds 模式:   BDS 1.21.90+ 无 RCON, 写 stdin 后收集 stdout, 500ms 无新输出判定响应完成
   *  exec 严格串行: 心跳 collectPlayers 与 poll 指令可能并发, 必须排队避免响应串扰 */
  exec(cmd, timeoutMs = 15000) {
    if (this._paper) {
      // Paper RCON: rcon.exec 自带重连/重试
      if (!this.rcon || typeof this.rcon.exec !== 'function') {
        return Promise.reject(new Error('RCON 不可用 (paper 模式)'));
      }
      return Promise.resolve().then(() => this.rcon.exec(cmd)).catch(err => {
        // 统一抛 Error, 与 bds 模式一致
        throw (err instanceof Error ? err : new Error(String(err)));
      });
    }
    const task = this._chain.then(() => this._execOne(cmd, timeoutMs));
    this._chain = task.catch(() => {});
    return task;
  }

  _execOne(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin) return reject(new Error('BDS 未运行'));
      const waiter = {
        cmd: cmd.trim(),
        resp: [],
        collecting: false,   // write 成功回调后置 true, 之后的 stdout 行才视为响应
        resolve, reject,
        idleTimer: null,     // 行间静默计时 (响应已开始)
        firstLineTimer: null, // 首行等待: 3s 无任何输出视为"无输出命令"(say/kick/ban 成功时静默)
        done: false,
      };
      this._active = waiter;
      this._stdinQueue = this._stdinQueue.then(() => new Promise(res => {
        try {
          this.proc.stdin.write(waiter.cmd + '\n', () => {
            waiter.collecting = true;
            res();
            // 3s 无任何输出 → 命令已被接受但无回显 (say/kick/ban/op 成功时控制台静默), 视为成功
            waiter.firstLineTimer = setTimeout(() => {
              if (!waiter.done) this._finishWaiter(waiter, true, waiter.resp.join('\n'), null);
            }, 3000);
          });
        } catch { res(); }
      })).catch(() => {});
      // 总超时兜底
      setTimeout(() => this._finishWaiter(waiter, false, null, `命令超时: ${cmd}`), timeoutMs);
    });
  }

  /** 结束等待: 成功(resolve resp) 或 失败(reject err) */
  _finishWaiter(waiter, ok, resp, err) {
    if (waiter.done) return;
    waiter.done = true;
    if (waiter.idleTimer) clearTimeout(waiter.idleTimer);
    if (waiter.firstLineTimer) clearTimeout(waiter.firstLineTimer);
    if (this._active === waiter) this._active = null;
    if (ok) waiter.resolve(resp);
    else waiter.reject(new Error(err));
  }

  /** 从 stdout 行解析命令响应 (无回显依赖) */
  _onStdoutLine(line) {
    const stripped = line.trim();
    if (!stripped) return;
    const waiter = this._active;  // 只有一个活动命令 (exec 串行)
    if (!waiter || !waiter.collecting) return;  // write 回调前到达的行忽略
    if (waiter.firstLineTimer) { clearTimeout(waiter.firstLineTimer); waiter.firstLineTimer = null; }
    // 命令响应与常规日志同带 [ts LEVEL] 前缀, 无法严格区分 → 收集, 靠静默期截断
    waiter.resp.push(stripped);
    if (waiter.idleTimer) clearTimeout(waiter.idleTimer);
    waiter.idleTimer = setTimeout(() => {
      this._finishWaiter(waiter, true, waiter.resp.join('\n'), null);
    }, 500);
  }


  async start() {
    if (this.proc) return;
    this._restarting = false;
    const script = this.cfg.runScript;
    if (!fs.existsSync(script)) throw new Error(`运行脚本不存在: ${script}`);
    this._log('info', `正在启动 ${this._paper ? 'Paper' : 'BDS'} ...`);
    // run.sh 内部 cd 到服务端目录; stdin/stdout 用管道 (console 控制台通道)
    this.proc = spawn('bash', [script], { cwd: this.cfg.dir, env: process.env });
    this.pid = this.proc.pid;
    this.running = true;

    this.proc.stdout.on('data', chunk => this._feed(chunk.toString()));
    this.proc.stderr.on('data', chunk => this._feed(chunk.toString()));
    this.proc.on('error', err => this._log('error', `进程错误: ${err.message}`));
    this.proc.on('exit', (code, signal) => {
      this._log('warn', `${this._paper ? 'Paper' : 'BDS'} 进程退出 code=${code} signal=${signal}`);
      const crashed = this.running && !this._restarting;
      this.proc = null; this.pid = null; this.running = false;
      // 清理活动命令
      if (this._active && !this._active.done) this._finishWaiter(this._active, false, null, 'BDS 已退出');
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
    await this._waitStarted(this.cfg.startTimeoutMs || 120000);
    this.emit('started');
  }

  _waitStarted(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        // BDS: "Server started"/"IPv6 supported" | Paper: "Done (Xs)!"
        const ok = this._paper
          ? this._logBuffer.some(l => l.includes('Done ('))
          : this._logBuffer.some(l => l.includes('Server started') || l.includes('IPv6 supported'));
        if (ok) {
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
    this._log('info', `正在停止 ${this._paper ? 'Paper' : 'BDS'} ...`);
    if (this._paper) {
      // Paper: RCON stop (自动保存世界后退出)
      try { await this.rcon.exec('stop'); } catch {}
    } else {
      // console 通道: save hold 后 stop
      try { await this.exec('save hold', 8000).catch(() => {}); } catch {}
      try { await this.exec('stop', 10000).catch(() => {}); } catch {}
    }
    // 等待退出, 最长 30s
    const t0 = Date.now();
    while (this.proc && Date.now() - t0 < 30000) await new Promise(r => setTimeout(r, 200));
    if (this.proc) {
      this._log('warn', '服务端未在 30s 内退出, 强制终止');
      try { this.proc.kill('SIGKILL'); } catch {}
    }
    this._restarting = false;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  /** 兼容: 直接发命令不等响应 (fire-and-forget) */
  sendStdin(cmd) {
    if (!this.proc || !this.proc.stdin) throw new Error('BDS 未运行');
    this._stdinQueue = this._stdinQueue.then(() => new Promise(res => {
      try { this.proc.stdin.write(cmd + '\n', res); } catch { res(); }
    }));
  }

  _feed(text) {
    // 按行拆分 (兼容 \r\n)
    this._lineBuffer += text;
    const lines = this._lineBuffer.split(/\r?\n/);
    this._lineBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      this._onStdoutLine(line);
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
