// Worker REST 逻辑本地验证 (不依赖 workerd)
// 用法: node test/harness.js <port>
// 覆盖: / 健康检查, /api/status 离线 503, 401, 404, /api/cmd 缺参
import http from 'node:http';

// 注入 env (模拟 wrangler vars)
const env = {
  AGENT_TOKEN: 'test-token',
  PANEL_JWT_SECRET: 'test-jwt',
  ALLOWED_AGENT_ID: 'mc1life-test',
  PANEL_AUTH_TOKEN: process.env.PANEL_AUTH_TOKEN || 'test-panel-token',
};

const { default: app } = await import('../src/index.js');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // 构造 Request (fetch API 格式)
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
  let body;
  if (req.method === 'POST') {
    body = await new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => resolve(d));
    });
  }
  const request = new Request(url.toString(), { method: req.method, headers, body: body || undefined });
  try {
    const resp = await app.fetch(request, env, {});
    res.writeHead(resp.status, Object.fromEntries(resp.headers));
    res.end(await resp.text());
  } catch (e) {
    console.error('[harness] fetch error:', e);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal Server Error: ' + (e.message || e));
  }
});

const port = Number(process.argv[2] || 8790);
server.listen(port, () => console.log(`[harness] worker REST 测试服务 :${port}`));
