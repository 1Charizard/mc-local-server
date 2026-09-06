// HTTP 轮询客户端 v2 (手机 -> Cloudflare pages.dev REST)
// 稳定性改进: 心跳失败立即重试 / poll 串行化防堆叠 / 超时 15s
const http = require('http');
const https = require('https');

class PollClient {
  constructor(config, { onMessage }) {
    this.config = config;
    this.onMessage = onMessage || (() => {});
    this._pollTimer = null;
    this._hbTimer = null;
    this._hbRetryTimer = null;
    this._polling = false;      // poll 串行化标志
    this._hbInFlight = false;   // 心跳防重叠
    this._stopped = false;
    this._hbFailCount = 0;
  }

  _base() {
    let u = this.config.workerUrl;
    u = u.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
    u = u.replace(/\/ws\/agent.*$/i, '');
    return u;
  }

  _auth() {
    return `agent=${encodeURIComponent(this.config.agentId)}&token=${encodeURIComponent(this.config.token)}`;
  }

  _req(method, path, body, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const url = `${this._base()}/api/agent${path}?${this._auth()}`;
      const mod = url.startsWith('https') ? https : http;
      const data = body ? JSON.stringify(body) : null;
      const req = mod.request(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-agent-token': this.config.token,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: timeoutMs,
      }, (res) => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch { resolve({ ok: false, error: '响应解析失败: ' + buf.slice(0, 200) }); }
        });
      });
      req.on('error', (e) => {
        console.error(`[MC1life] 请求错误 (${method} ${path}): code=${e.code} ${e.message}`);
        reject(e);
      });
      req.on('timeout', () => { req.destroy(new Error('请求超时')); });
      if (data) req.write(data);
      req.end();
    });
  }

  connect() {
    this._hb();
    this._poll();
    this._hbTimer = setInterval(() => this._hb(), 8000);
    this._pollTimer = setInterval(() => this._poll(), 3000);
    console.log(`[MC1life] 轮询模式启动: ${this._base()}/api/agent?${this._auth()}`);
  }

  async _hb() {
    if (this._hbInFlight) return; // 上一次还没结束, 跳过
    this._hbInFlight = true;
    try {
      const state = await this.onMessage({ type: 'status-request' });
      const logs = (await this.onMessage({ type: 'drain-logs' })) || [];
      await this._req('POST', '/heartbeat', { status: state, logs }, 15000);
      this._hbFailCount = 0;
    } catch (e) {
      this._hbFailCount++;
      console.error(`[MC1life] 心跳失败 (第 ${this._hbFailCount} 次): ${e.message}`);
      // 立即重试 (最多 3 次), 避免长时间心跳空白导致面板判离线
      if (this._hbFailCount <= 3 && !this._stopped) {
        clearTimeout(this._hbRetryTimer);
        this._hbRetryTimer = setTimeout(() => this._hb(), 2000);
      }
    } finally {
      this._hbInFlight = false;
    }
  }

  async _poll() {
    if (this._polling) return; // 串行化: 上次 poll 没结束不重叠
    this._polling = true;
    try {
      const r = await this._req('GET', '/poll', null, 15000);
      console.log('[MC1life] poll resp:', JSON.stringify(r).slice(0, 200));
      if (r && r.ok && Array.isArray(r.cmds)) {
        for (const cmd of r.cmds) {
          console.log('[MC1life] 执行指令:', cmd.kind, JSON.stringify(cmd.payload || {}).slice(0, 150));
          const result = await this.onMessage({ type: 'cmd', cmd });
          console.log('[MC1life] 指令结果:', JSON.stringify(result).slice(0, 200));
          await this._req('POST', '/result', { id: cmd.id, ...result }, 15000).catch((e) => {
            console.error('[MC1life] 回传结果失败:', e.message);
          });
        }
      }
    } catch (e) {
      console.error('[MC1life] 拉取指令失败:', e.message);
    } finally {
      this._polling = false;
    }
  }

  /** 兼容旧接口 */
  send() { return true; }
  close() {
    this._stopped = true;
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._hbTimer) clearInterval(this._hbTimer);
    if (this._hbRetryTimer) clearTimeout(this._hbRetryTimer);
  }
}

module.exports = PollClient;
