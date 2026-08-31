// 模拟 RCON 服务器 (Source RCON 协议), 用于测试 agent 的 rcon.js
// 用法: node test/mock_rcon_server.js <port> <password>
const net = require('net');

const port = Number(process.argv[2] || 25575);
const password = process.argv[3] || 'testpass';

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let authed = false;

  function sendPacket(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const len = 4 + 4 + b.length + 2;
    const pkt = Buffer.alloc(4 + len);
    pkt.writeInt32LE(len, 0);
    pkt.writeInt32LE(id, 4);
    pkt.writeInt32LE(type, 8);
    b.copy(pkt, 12);
    pkt.writeInt16LE(0, 12 + b.length);
    sock.write(pkt);
  }

  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 12) {
      const len = buf.readInt32LE(0);
      if (buf.length < 4 + len) break;
      const id = buf.readInt32LE(4);
      const type = buf.readInt32LE(8);
      const body = buf.slice(12, 4 + len - 2).toString('utf8');
      buf = buf.slice(4 + len);
      if (type === 3) { // auth
        if (body === password) { authed = true; sendPacket(id, 2, ''); }
        else sendPacket(-1, 2, '');
      } else if (type === 2 && authed) {
        let out;
        if (body === 'list') out = 'There are 2/20 players online: alex, steve';
        else if (body === 'save hold') out = 'Saving...';
        else out = `OK: ${body}`;
        sendPacket(id, 0, out);
      }
    }
  });
});

server.listen(port, () => console.log(`[mock-rcon] listening on :${port} (pass=${password})`));
