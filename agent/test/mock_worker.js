// 模拟 Cloudflare Worker: 接受 /ws/agent 连接, 打印 Agent 上报, 响应 ping
// 用法: node test/mock_worker.js <port>
const WebSocket = require('ws');
const http = require('http');

const port = Number(process.argv[2] || 8787);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('mock worker ok');
});

const wss = new WebSocket.Server({ server, path: '/ws/agent' });

wss.on('connection', (ws, req) => {
  console.log('[mock-worker] agent connected:', req.url);
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (msg.type === 'hello') console.log('[mock-worker] hello:', JSON.stringify(msg.data));
    else if (msg.type === 'status') console.log('[mock-worker] status:', JSON.stringify(msg.data));
    else if (msg.type === 'log') console.log('[mock-worker] log lines:', msg.data.lines.length);
    else if (msg.type === 'cmdResult') console.log('[mock-worker] cmdResult:', JSON.stringify(msg.data));
    else console.log('[mock-worker] msg:', msg.type, JSON.stringify(msg.data || {}).slice(0, 200));
  });
});

server.listen(port, () => console.log(`[mock-worker] listening on :${port}`));
