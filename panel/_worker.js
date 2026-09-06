// MC1life Pages Functions (_worker.js advanced mode)
// 统一入口: 面板静态资源 + API/WS 代理到后端 Worker (mc1life-api.mc1life.workers.dev)
// + /dl 下载代理 (BDS zip, 经 CF 边缘访问 minecraft.net, 国内可达)
// 这样国内浏览器只需访问 pages.dev (可达), 后端通信由 Cloudflare 边缘完成
// API_ORIGIN 在 fetch() 内读取: Pages 环境变量注入, 无则用占位符 (部署时替换为真实 Worker 域名)
const FALLBACK_API = 'https://YOUR_WORKER.workers.dev';
// 面板 token (与 Worker 的 PANEL_AUTH_TOKEN 一致, 通过 Pages 环境变量注入)
const PANEL_TOKEN = env => env?.PANEL_AUTH_TOKEN || '';

function checkToken(request, token) {
  const url = new URL(request.url);
  const q = url.searchParams.get('token') || '';
  const h = request.headers.get('Authorization') || '';
  const provided = q || (h.startsWith('Bearer ') ? h.slice(7) : '');
  return provided && token && provided === token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const API_ORIGIN = env?.API_ORIGIN || FALLBACK_API;

    // ---- 下载代理: /dl?url=<https://www.minecraft.net/...> ----
    if (path === '/dl') {
      if (!checkToken(request, PANEL_TOKEN(env))) {
        return new Response('Unauthorized', { status: 401 });
      }
      const target = url.searchParams.get('url') || '';
      if (!target || !/^https:\/\/(www\.)?(minecraft\.net|github\.com)\//i.test(target)) {
        return new Response('仅允许下载 minecraft.net / github.com 文件', { status: 403 });
      }
      const upstream = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 MC1life' } });
      if (!upstream.ok) return new Response(`上游 HTTP ${upstream.status}`, { status: 502 });
      const headers = new Headers(upstream.headers);
      headers.set('Content-Disposition', `attachment; filename="${target.split('/').pop()}"`);
      return new Response(upstream.body, { status: 200, headers });
    }

    // ---- API 代理 (REST) ----
    if (path.startsWith('/api/')) {
      const target = API_ORIGIN + path + url.search;
      const headers = new Headers(request.headers);
      headers.set('Host', new URL(API_ORIGIN).host);
      const proxyReq = new Request(target, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { duplex: 'half' }),
      });
      return fetch(proxyReq);
    }

    // ---- WebSocket 代理 (面板 <-> Agent 实时通道) ----
    // 注意: Pages Functions 不能直接 return fetch(resp) 转发 WS,
    // 必须用 WebSocketPair 显式双向桥接, 否则握手成功但消息不转发
    if (path.startsWith('/ws/')) {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade?.toLowerCase() !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }
      const target = API_ORIGIN + path + url.search;
      const headers = new Headers(request.headers);
      headers.set('Host', new URL(API_ORIGIN).host);
      const proxyReq = new Request(target, { method: 'GET', headers });
      const resp = await fetch(proxyReq);
      if (resp.status !== 101 || !resp.webSocket) {
        return new Response('WebSocket proxy failed: ' + resp.status, { status: 502 });
      }
      const upstream = resp.webSocket;
      try { upstream.accept(); } catch {}
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      // 双向桥接
      upstream.addEventListener('message', (ev) => { try { server.send(ev.data); } catch {} });
      server.addEventListener('message', (ev) => { try { upstream.send(ev.data); } catch {} });
      upstream.addEventListener('close', () => { try { server.close(); } catch {} });
      server.addEventListener('close', () => { try { upstream.close(); } catch {} });
      upstream.addEventListener('error', () => { try { server.close(); } catch {} });
      server.addEventListener('error', () => { try { upstream.close(); } catch {} });
      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- 静态资源 ----
    return env.ASSETS.fetch(request);
  },
};
