// 极简 Source RCON 客户端 (BDS 支持)
// 协议: https://wiki.vg/RCON (小端序)
const net = require('net');

class RCON {
  constructor({ host = '127.0.0.1', port = 25575, password = '' }) {
    this.host = host; this.port = port; this.password = password;
    this.sock = null;
    this._seq = 0;
    this._pending = new Map();
    this._buffer = Buffer.alloc(0);
    this._connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this._connected) return resolve();
      const sock = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('RCON 连接超时')); }, 5000);
      sock.on('connect', () => {
        clearTimeout(timer);
        this.sock = sock; this._connected = true;
        this._buffer = Buffer.alloc(0);
        sock.on('data', d => this._onData(d));
        sock.on('close', () => { this._connected = false; this.sock = null; });
        sock.on('error', () => { this._connected = false; this.sock = null; });
        this._auth().then(resolve).catch(reject);
      });
      sock.on('error', err => { clearTimeout(timer); reject(err); });
    });
  }

  _auth() {
    return this._send(3, this.password);
  }

  _send(type, payload) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('RCON 未连接'));
      const id = ++this._seq;
      const body = Buffer.from(payload, 'utf8');
      const len = 4 + 4 + body.length + 2;
      const pkt = Buffer.alloc(4 + len);
      pkt.writeInt32LE(len, 0);
      pkt.writeInt32LE(id, 4);
      pkt.writeInt32LE(type, 8);
      body.copy(pkt, 12);
      pkt.writeInt16LE(0, 12 + body.length); // 空终止
      this._pending.set(id, { resolve, reject, t: setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('RCON 响应超时'));
      }, 10000) });
      this.sock.write(pkt);
    });
  }

  _onData(data) {
    this._buffer = Buffer.concat([this._buffer, data]);
    while (this._buffer.length >= 12) {
      const len = this._buffer.readInt32LE(0);
      if (this._buffer.length < 4 + len) break;
      const id = this._buffer.readInt32LE(4);
      const type = this._buffer.readInt32LE(8);
      const body = this._buffer.slice(12, 4 + len - 2).toString('utf8');
      this._buffer = this._buffer.slice(4 + len);
      if (id === -1) continue; // auth 失败
      const p = this._pending.get(id);
      if (p) {
        clearTimeout(p.t);
        this._pending.delete(id);
        if (type === 0 || type === 2) p.resolve(body);
        else p.reject(new Error(`RCON 响应类型错误: ${type}`));
      }
    }
  }

  async exec(command, retries = 2) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        if (!this._connected) await this.connect();
        return await this._send(2, command);
      } catch (e) {
        lastErr = e;
        this._connected = false;
        await new Promise(r => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw lastErr;
  }
}

module.exports = RCON;
