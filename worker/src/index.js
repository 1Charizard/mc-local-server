// MC1life Worker - 入口 v3 (HTTP 轮询架构: 双密码 + 离线可访问 + 硬核 + 存档上传)
// 背景: 手机端访问不了 workers.dev, 面板走 pages.dev 代理 (REST 通, WS 代理不转发消息)
//       因此 Agent <-> Worker 改为 HTTP 轮询: 心跳/拉指令/回传结果, 状态存 KV
// 路由:
//   POST /api/auth                     -> 登录校验, 返回角色 admin/viewer
//   GET  /api/status                   -> 服务器状态 (KV, Agent 离线也返回 offline 标记)
//   GET  /api/logs?after=ts            -> 最近日志
//   POST /api/cmd                      -> 执行指令 {command} (admin)
//   POST /api/server/start|stop|restart (admin)
//   GET  /api/players                  -> 玩家列表
//   POST /api/players/kick|ban|unban|op|deop (admin)
//   GET  /api/backups                  -> 备份列表
//   POST /api/backups                  -> 创建备份 (admin)
//   POST /api/backups/restore          -> 回滚 {backupId} (admin)
//   GET  /api/worlds                   -> 世界列表
//   POST /api/worlds/switch            -> 切换世界 {name} (admin)
//   POST /api/worlds/upload            -> 网页上传存档 (multipart, admin, 分片存 KV 暂存 -> Agent 拉取)
//   GET/POST /api/hardcore             -> 硬核模式配置读写 (admin)
//   GET  /api/config?file=...          -> 配置文件
//   POST /api/config                   -> 修改配置 {file,key,value,restart} (admin)
//   GET  /api/audit                    -> 审计日志
//   ---- Agent 轮询端点 (token 认证) ----
//   POST /api/agent/heartbeat          -> Agent 上报状态 {status}
//   GET  /api/agent/poll               -> Agent 拉取待执行指令
//   POST /api/agent/result             -> Agent 回传指令结果 {id, ok, result|error}
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('/api/*', cors({ origin: '*', allowMethods: ['GET','POST','OPTIONS'], allowHeaders: ['Content-Type','Authorization'] }));

// ---------------- 工具 ----------------
const AUTH = {
  checkAgent(c) {
    const url = new URL(c.req.url);
    const token = url.searchParams.get('token') || c.req.raw.headers.get('x-agent-token') || '';
    const agent = url.searchParams.get('agent') || '';
    if (agent !== (c.env?.ALLOWED_AGENT_ID || 'mc1life')) return null;
    return token === (c.env?.AGENT_TOKEN || '') ? agent : null;
  },
  /** 返回 'admin' | 'viewer' | null */
  checkPanel(c) {
    const h = c.req.raw.headers.get('Authorization') || '';
    if (h.startsWith('Bearer ')) {
      const token = h.slice(7);
      if (token && token === (c.env?.PANEL_AUTH_TOKEN || '')) return 'admin';
      if (token && token === (c.env?.PANEL_VIEWER_TOKEN || '')) return 'viewer';
    }
    return null;
  },
};

const STATE_KEY = 'agent:state';
// 大数组转 base64: 分块 String.fromCharCode, 避免 spread 爆栈 (>0x8000 参数)
function bytesToB64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}
const UPLOAD_KEY = 'agent:upload:';

// Agent 在线判定: KV state 存在且 45 秒内更新过
async function agentOnline(env) {
  try {
    const s = await env.SESSION_KV.get(STATE_KEY, 'json');
    if (!s) return false;
    // 手机弱网容忍: 心跳 8s + 失败立即重试, 120s 窗口几乎不会误判
    return Date.now() - (s.ts || 0) < 120000;
  } catch { return false; }
}

/**
 * 提交指令到队列, 等待 Agent 轮询执行并回传结果 (最多 30s)
 * 队列与结果存 D1 (tasks 表): D1 复制延迟远小于 KV, 避免跨 POP 读不到 KV 导致指令"丢失"
 */
async function submitCmd(env, kind, payload, timeoutMs = 30000) {
  if (!(await agentOnline(env))) return { ok: false, error: 'Agent 当前离线, 请稍后重试' };
  const id = crypto.randomUUID();
  const payloadStr = JSON.stringify({ kind, payload });
  // 入队 (D1 INSERT)
  try {
    await env.DB.prepare('INSERT INTO tasks (id, type, status, payload) VALUES (?, ?, ?, ?)')
      .bind(id, 'cmd', 'pending', payloadStr).run();
  } catch (e) {
    return { ok: false, error: '指令入队失败: ' + e.message };
  }
  // 轮询结果 (D1 SELECT; 亚秒级复制, 30s 内必然可见)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare('SELECT status, result FROM tasks WHERE id = ?')
      .bind(id).first().catch(() => null);
    if (row && row.status === 'done') {
      let r = { ok: true };
      try { r = JSON.parse(row.result || '{}'); } catch {}
      await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run().catch(() => {});
      return { ok: r.ok !== false, result: r.result, error: r.error };
    }
    if (row && row.status === 'failed') {
      await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run().catch(() => {});
      let r = {};
      try { r = JSON.parse(row.result || '{}'); } catch {}
      return { ok: false, error: r.error || '指令执行失败' };
    }
    await new Promise(res => setTimeout(res, 800));
  }
  // 超时: 标记 failed, 由 Agent 侧兜底不重复处理
  await env.DB.prepare("UPDATE tasks SET status = 'failed', finished_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .bind(id).run().catch(() => {});
  return { ok: false, error: 'Agent 响应超时' };
}

// ---------------- 登录校验 ----------------
app.post('/api/auth', async (c) => {
  const who = AUTH.checkPanel(c);
  if (!who) return c.json({ ok: false, error: '密码错误' }, 401);
  return c.json({ ok: true, role: who });
});

// ---------------- 面板鉴权中间件 ----------------
app.use('/api/*', async (c, next) => {
  // Agent 端点走 Agent token, 跳过面板鉴权
  if (c.req.path.startsWith('/api/agent/')) return next();
  const who = AUTH.checkPanel(c);
  if (!who) return c.json({ ok: false, error: '未授权, 请先登录面板' }, 401);
  c.set('role', who);
  const method = c.req.method;
  if (c.req.path === '/api/auth') return next();
  if (method !== 'GET' && who !== 'admin') {
    return c.json({ ok: false, error: '访客账号无操作权限 (只读)' }, 403);
  }
  await next();
});

// ---------------- 下载代理 (BDS zip 等; 需面板 token) ----------------
app.get('/dl', async (c) => {
  const who = AUTH.checkPanel(c);
  if (!who) return c.json({ ok: false, error: '未授权' }, 401);
  const url = c.req.query('url') || '';
  if (!url || !/^https:\/\//i.test(url)) return c.json({ ok: false, error: '缺少 url 参数' }, 400);
  const allowedHosts = ['www.minecraft.net', 'minecraft.net'];
  let host;
  try { host = new URL(url).hostname; } catch { return c.json({ ok: false, error: 'url 非法' }, 400); }
  if (!allowedHosts.includes(host)) return c.json({ ok: false, error: '仅允许下载 minecraft.net 文件' }, 403);

  const upstream = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 MC1life' } });
  if (!upstream.ok) return c.json({ ok: false, error: `上游 HTTP ${upstream.status}` }, 502);
  const headers = new Headers(upstream.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Content-Disposition', `attachment; filename="${url.split('/').pop()}"`);
  return new Response(upstream.body, { status: 200, headers });
});

// ---------------- Agent 轮询端点 ----------------
// Agent 心跳: 上报状态 + 附带日志
app.post('/api/agent/heartbeat', async (c) => {
  const agent = AUTH.checkAgent(c);
  if (!agent) return c.json({ ok: false, error: '未授权' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const state = { ...(body.status || {}), ts: Date.now() };
  await c.env.SESSION_KV.put(STATE_KEY, JSON.stringify(state));
  // 日志追加 (最多 500 行)
  if (Array.isArray(body.logs) && body.logs.length) {
    const prev = JSON.parse((await c.env.SESSION_KV.get('agent:logs')) || '[]');
    const merged = [...prev, ...body.logs].slice(-500);
    await c.env.SESSION_KV.put('agent:logs', JSON.stringify(merged));
  }
  return c.json({ ok: true, ts: state.ts });
});

// Agent 拉取指令 (D1 tasks 表: 单条原子出队, 不丢不重)
app.get('/api/agent/poll', async (c) => {
  const agent = AUTH.checkAgent(c);
  if (!agent) return c.json({ ok: false, error: '未授权' }, 401);
  const row = await c.env.DB
    .prepare("SELECT id, payload FROM tasks WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .first().catch(() => null);
  if (!row) return c.json({ ok: true, cmds: [] });
  // 标记 running (防止 submitCmd 超时后另一 poll 重复取到)
  await c.env.DB.prepare("UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'pending'")
    .bind(row.id).run().catch(() => {});
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch {}
  return c.json({ ok: true, cmds: [{ id: row.id, ...payload }] });
});

// Agent 回传结果 (D1 UPDATE; submitCmd 轮询 D1 亚秒级可见)
app.post('/api/agent/result', async (c) => {
  const agent = AUTH.checkAgent(c);
  if (!agent) return c.json({ ok: false, error: '未授权' }, 401);
  const { id, ok, result, error } = await c.req.json().catch(() => ({}));
  if (!id) return c.json({ ok: false, error: '缺少 id' }, 400);
  await c.env.DB
    .prepare("UPDATE tasks SET status = ?, result = ?, finished_at = datetime('now') WHERE id = ?")
    .bind(ok ? 'done' : 'failed', JSON.stringify({ ok, result, error, ts: Date.now() }), id)
    .run().catch(() => {});
  return c.json({ ok: true });
});

// Agent 拉取上传分片 (面板上传存档时 KV 暂存, Agent 按 index 拉取)
app.get('/api/agent/upload/:id/:idx', async (c) => {
  const agent = AUTH.checkAgent(c);
  if (!agent) return c.json({ ok: false, error: '未授权' }, 401);
  const { id, idx } = c.req.param();
  const b64 = await c.env.SESSION_KV.get(`${UPLOAD_KEY}${id}:chunk:${idx}`);
  if (b64 === null) return c.json({ ok: false, error: '分片不存在或已过期' }, 404);
  return new Response(b64, { headers: { 'Content-Type': 'text/plain' } });
});

// 清理过期上传会话 (Agent 完成导入后调用)
app.post('/api/agent/upload/:id/cleanup', async (c) => {
  const agent = AUTH.checkAgent(c);
  if (!agent) return c.json({ ok: false, error: '未授权' }, 401);
  const { id } = c.req.param();
  const meta = JSON.parse((await c.env.SESSION_KV.get(`${UPLOAD_KEY}${id}:meta`)) || 'null');
  if (meta) {
    for (let i = 0; i < meta.totalChunks; i++) {
      await c.env.SESSION_KV.delete(`${UPLOAD_KEY}${id}:chunk:${i}`);
    }
    await c.env.SESSION_KV.delete(`${UPLOAD_KEY}${id}:meta`);
  }
  return c.json({ ok: true });
});

// ---- 导出上传端点 (Agent 分片 POST, KV 暂存, TTL 1h) ----
const EXPORT_KEY = 'export:';
app.post('/api/agent/export/start', async (c) => {
  const agent = AUTH.checkAgent(c);
  if (!agent) return c.json({ ok: false, error: '未授权' }, 401);
  const { exportId, worldName, totalChunks, size, fileName } = await c.req.json().catch(() => ({}));
  if (!exportId || !totalChunks) return c.json({ ok: false, error: '缺少参数' }, 400);
  if (size > 500 * 1024 * 1024) return c.json({ ok: false, error: '世界过大 (>500MB)' }, 400);
  await c.env.SESSION_KV.put(`${EXPORT_KEY}${exportId}:meta`, JSON.stringify({ exportId, worldName, totalChunks, size, fileName, ts: Date.now() }), { expirationTtl: 3600 });
  return c.json({ ok: true });
});
app.post('/api/agent/export/chunk', async (c) => {
  const agent = AUTH.checkAgent(c);
  if (!agent) return c.json({ ok: false, error: '未授权' }, 401);
  const { exportId, index, data } = await c.req.json().catch(() => ({}));
  if (!exportId || index === undefined || !data) return c.json({ ok: false, error: '缺少分片参数' }, 400);
  if (data.length > 2.2 * 1024 * 1024) return c.json({ ok: false, error: '分片过大' }, 400);
  await c.env.SESSION_KV.put(`${EXPORT_KEY}${exportId}:chunk:${index}`, data, { expirationTtl: 3600 });
  return c.json({ ok: true, received: index + 1 });
});
app.post('/api/agent/export/complete', async (c) => {
  const agent = AUTH.checkAgent(c);
  if (!agent) return c.json({ ok: false, error: '未授权' }, 401);
  const { exportId } = await c.req.json().catch(() => ({}));
  if (!exportId) return c.json({ ok: false, error: '缺少 exportId' }, 400);
  // 验证分片齐全
  const meta = JSON.parse((await c.env.SESSION_KV.get(`${EXPORT_KEY}${exportId}:meta`)) || 'null');
  if (!meta) return c.json({ ok: false, error: '导出会话不存在' }, 404);
  for (let i = 0; i < meta.totalChunks; i++) {
    const ck = await c.env.SESSION_KV.get(`${EXPORT_KEY}${exportId}:chunk:${i}`);
    if (ck === null) return c.json({ ok: false, error: `分片缺失 (${i}/${meta.totalChunks})` }, 500);
  }
  return c.json({ ok: true, exportId });
});

// ---------------- REST API ----------------
app.get('/api/status', async (c) => {
  const online = await agentOnline(c.env);
  if (!online) return c.json({ ok: false, agent: 'offline' }, 200);
  const state = JSON.parse((await c.env.SESSION_KV.get(STATE_KEY)) || '{}');
  return c.json(state);
});

app.get('/api/logs', async (c) => {
  const logs = JSON.parse((await c.env.SESSION_KV.get('agent:logs')) || '[]');
  return c.json({ lines: logs, total: logs.length });
});

app.post('/api/cmd', async (c) => {
  const { command } = await c.req.json();
  if (!command || typeof command !== 'string') return c.json({ ok: false, error: '缺少 command' });
  if (command.length > 500) return c.json({ ok: false, error: '指令过长' });
  await logAudit(c.env, 'admin', 'cmd', command);
  const r = await submitCmd(c.env, 'exec', { command });
  return c.json(r);
});

app.post('/api/server/start', async (c) => c.json(await submitCmd(c.env, 'start', {})));
app.post('/api/server/stop', async (c) => c.json(await submitCmd(c.env, 'stop', {})));
app.post('/api/server/restart', async (c) => c.json(await submitCmd(c.env, 'restart', {})));

app.get('/api/players', async (c) => {
  const state = JSON.parse((await c.env.SESSION_KV.get(STATE_KEY)) || '{}');
  return c.json({ result: state.players || [] });
});

const playerActions = {
  '/api/players/kick': 'kick', '/api/players/ban': 'ban', '/api/players/unban': 'unban',
  '/api/players/op': 'op', '/api/players/deop': 'deop',
};
for (const [route, kind] of Object.entries(playerActions)) {
  app.post(route, async (c) => {
    const { name, reason } = await c.req.json();
    if (!name) return c.json({ ok: false, error: '缺少玩家名' });
    const r = await submitCmd(c.env, kind, { name, reason });
    return c.json(r);
  });
}

app.get('/api/backups', async (c) => {
  const r = await submitCmd(c.env, 'listBackups', {});
  if (!r.ok) return c.json(r);
  return c.json({ result: r.result });
});
app.post('/api/backups', async (c) => {
  const { name } = await c.req.json().catch(() => ({}));
  await logAudit(c.env, 'admin', 'backup', name || 'manual');
  const r = await submitCmd(c.env, 'backup', { name });
  return c.json(r);
});
app.post('/api/backups/restore', async (c) => {
  const { backupId } = await c.req.json();
  if (!backupId) return c.json({ ok: false, error: '缺少 backupId' });
  await logAudit(c.env, 'admin', 'restore', backupId);
  const r = await submitCmd(c.env, 'restore', { backupId });
  return c.json(r);
});

app.get('/api/worlds', async (c) => {
  // 优先读 Agent 心跳上报的世界列表缓存 (即时返回, 不阻塞等 Agent)
  const state = JSON.parse((await c.env.SESSION_KV.get(STATE_KEY)) || '{}');
  if (Array.isArray(state.worlds)) return c.json({ result: state.worlds, cached: true });
  // Agent 在线但还没上报世界列表 (刚启动/导入中): 快速返回, 避免面板卡 25s 超时
  if (state && state.ts && Date.now() - state.ts < 120000) {
    return c.json({ ok: true, result: [], pending: true, message: '世界列表同步中, 请稍后刷新' });
  }
  return c.json({ ok: false, error: 'Agent 当前离线, 请稍后重试' }, 503);
});
app.post('/api/worlds/switch', async (c) => {
  const { name } = await c.req.json();
  if (!name) return c.json({ ok: false, error: '缺少世界名' });
  const r = await submitCmd(c.env, 'switchWorld', { name });
  return c.json(r);
});
// 删除世界 (仅非当前世界)
app.post('/api/worlds/delete', async (c) => {
  const { name } = await c.req.json();
  if (!name) return c.json({ ok: false, error: '缺少世界名' }, 400);
  await logAudit(c.env, 'admin', 'world_delete', name);
  const r = await submitCmd(c.env, 'deleteWorld', { name }, 60000);
  return c.json(r);
});
// 导出世界: Agent 打包分片上传 KV -> 返回 exportId (不依赖 R2)
app.post('/api/worlds/export', async (c) => {
  const { name } = await c.req.json();
  if (!name) return c.json({ ok: false, error: '缺少世界名' });
  await logAudit(c.env, 'admin', 'world_export', name);
  const r = await submitCmd(c.env, 'worldExport', { name }, 300000);
  return c.json(r);
});
// 导出下载: 分片端点 (前端循环拉 base64 拼接, 绕开 Worker CPU 限制)
app.get('/api/worlds/export/meta', async (c) => {
  const id = c.req.query('id') || '';
  if (!id || !id.startsWith('exp_')) return c.json({ ok: false, error: '缺少有效 id' }, 400);
  const meta = JSON.parse((await c.env.SESSION_KV.get(`export:${id}:meta`)) || 'null');
  if (!meta) return c.json({ ok: false, error: '导出不存在或已过期' }, 404);
  return c.json({ ok: true, meta });
});
app.get('/api/worlds/export/chunk', async (c) => {
  const id = c.req.query('id') || '';
  const i = Number(c.req.query('i') || '0');
  if (!id || !id.startsWith('exp_')) return c.json({ ok: false, error: '缺少有效 id' }, 400);
  const b64 = await c.env.SESSION_KV.get(`export:${id}:chunk:${i}`);
  if (b64 === null) return c.json({ ok: false, error: '分片缺失或已过期' }, 404);
  return new Response(b64, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
});

// 网页上传存档 (multipart) -> base64 存 KV 暂存 -> Agent 拉取并导入
app.post('/api/worlds/upload', async (c) => {
  if (!(await agentOnline(c.env))) return c.json({ ok: false, error: 'Agent 当前离线, 无法上传存档' }, 503);
  let form;
  try { form = await c.req.formData(); } catch { return c.json({ ok: false, error: '表单解析失败 (需 multipart/form-data)' }, 400); }
  const file = form.get('file');
  if (!file) return c.json({ ok: false, error: '缺少 file 字段' }, 400);
  const name = (form.get('name') || file.name || 'upload').replace(/[\\/:*?"<>|]/g, '');
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength === 0) return c.json({ ok: false, error: '文件为空' }, 400);
  const MAX = 90 * 1024 * 1024;
  if (buf.byteLength > MAX) return c.json({ ok: false, error: `文件过大 (${(buf.byteLength/1048576).toFixed(1)}MB), 上限 90MB` }, 400);

  // 分片 base64, 每片 1.5MB (KV 单值上限 25MB, 90MB 文件需 ~60 片)
  const CHUNK = 1536 * 1024;
  const uploadId = crypto.randomUUID().slice(0, 8);
  const total = Math.ceil(buf.byteLength / CHUNK);
  const baseName = name.replace(/\.(zip|mcworld|tar\.gz|tgz)$/i, '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'uploaded_world';
  await logAudit(c.env, 'admin', 'world_upload', `${name} (${(buf.byteLength/1048576).toFixed(1)}MB, ${total}片)`);

  // 元数据 + 分片写入 KV
  const meta = { uploadId, fileName: name, worldName: baseName, totalChunks: total, received: 0, ts: Date.now() };
  await c.env.SESSION_KV.put(UPLOAD_KEY + uploadId + ':meta', JSON.stringify(meta), { expirationTtl: 1800 });
  for (let i = 0; i < total; i++) {
    const slice = buf.slice(i * CHUNK, Math.min((i + 1) * CHUNK, buf.byteLength));
    const b64 = bytesToB64(slice);
    await c.env.SESSION_KV.put(UPLOAD_KEY + uploadId + ':chunk:' + i, b64, { expirationTtl: 1800 });
  }
  // 通知 Agent: 入队导入指令
  const r = await submitCmd(c.env, 'worldImportUpload', { uploadId, fileName: name, worldName: baseName, totalChunks: total }, 180000);
  return c.json(r);
});

// ---- 前端分片上传 (绕开 CF 100MB 单请求限制, 上限 500MB) ----
// POST /api/worlds/upload/start {fileName,size} -> {uploadId,totalChunks,worldName}
// POST /api/worlds/upload/chunk?id=&i=  body: 二进制分片
// POST /api/worlds/upload/finish {uploadId} -> 校验+入队 (不等待, 避免长超时)
const MAX_UPLOAD = 500 * 1024 * 1024;
const UPLOAD_CHUNK = 1536 * 1024;

app.post('/api/worlds/upload/start', async (c) => {
  const { fileName, size } = await c.req.json().catch(() => ({}));
  if (!fileName || !size) return c.json({ ok: false, error: '缺少参数' }, 400);
  if (size > MAX_UPLOAD) return c.json({ ok: false, error: `文件过大 (${(size/1048576).toFixed(1)}MB), 上限 500MB` }, 400);
  if (size <= 0) return c.json({ ok: false, error: '文件为空' }, 400);
  if (!(await agentOnline(c.env))) return c.json({ ok: false, error: 'Agent 当前离线, 无法上传存档' }, 503);
  const uploadId = crypto.randomUUID().slice(0, 8);
  const totalChunks = Math.ceil(size / UPLOAD_CHUNK);
  const worldName = fileName.replace(/\.(zip|mcworld|tar\.gz|tgz)$/i, '').replace(/[\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'uploaded_world';
  const meta = { uploadId, fileName: worldName, size, totalChunks, received: 0, ts: Date.now() };
  await c.env.SESSION_KV.put(UPLOAD_KEY + uploadId + ':meta', JSON.stringify(meta), { expirationTtl: 3600 });
  return c.json({ ok: true, uploadId, totalChunks, worldName });
});

app.post('/api/worlds/upload/chunk', async (c) => {
  const uploadId = c.req.query('id') || '';
  const index = Number(c.req.query('i') || '0');
  if (!uploadId) return c.json({ ok: false, error: '缺少 uploadId' }, 400);
  const meta = JSON.parse((await c.env.SESSION_KV.get(UPLOAD_KEY + uploadId + ':meta')) || 'null');
  if (!meta) return c.json({ ok: false, error: '上传会话不存在或已过期' }, 404);
  if (index < 0 || index >= meta.totalChunks) return c.json({ ok: false, error: '分片越界' }, 400);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength === 0) return c.json({ ok: false, error: '分片为空' }, 400);
  const b64 = bytesToB64(buf);
  await c.env.SESSION_KV.put(UPLOAD_KEY + uploadId + ':chunk:' + index, b64, { expirationTtl: 3600 });
  meta.received = Math.max(meta.received, index + 1);
  await c.env.SESSION_KV.put(UPLOAD_KEY + uploadId + ':meta', JSON.stringify(meta), { expirationTtl: 3600 });
  return c.json({ ok: true, received: meta.received, total: meta.totalChunks });
});

app.post('/api/worlds/upload/finish', async (c) => {
  const { uploadId } = await c.req.json().catch(() => ({}));
  if (!uploadId) return c.json({ ok: false, error: '缺少 uploadId' }, 400);
  const meta = JSON.parse((await c.env.SESSION_KV.get(UPLOAD_KEY + uploadId + ':meta')) || 'null');
  if (!meta) return c.json({ ok: false, error: '上传会话不存在或已过期' }, 404);
  for (let i = 0; i < meta.totalChunks; i++) {
    const ck = await c.env.SESSION_KV.get(UPLOAD_KEY + uploadId + ':chunk:' + i);
    if (ck === null) return c.json({ ok: false, error: `分片缺失 (${i}/${meta.totalChunks})` }, 500);
  }
  if (!(await agentOnline(c.env))) return c.json({ ok: false, error: 'Agent 当前离线, 无法导入存档' }, 503);
  await logAudit(c.env, 'admin', 'world_upload', `${meta.fileName} (${(meta.size/1048576).toFixed(1)}MB, ${meta.totalChunks}片)`);
  // 入队指令 (D1), 不等待结果 (Agent 后台导入, 面板轮询世界列表可见)
  const tid = crypto.randomUUID();
  const tpayload = JSON.stringify({ kind: 'worldImportUpload', payload: { uploadId, fileName: meta.fileName, worldName: meta.worldName || meta.fileName, totalChunks: meta.totalChunks } });
  await c.env.DB.prepare('INSERT INTO tasks (id, type, status, payload) VALUES (?, ?, ?, ?)')
    .bind(tid, 'cmd', 'pending', tpayload).run().catch(() => {});
  return c.json({ ok: true, pending: true, message: '已提交导入, Agent 后台处理中, 稍后刷新世界列表' });
});

// 硬核模式配置
app.get('/api/hardcore', async (c) => {
  const state = JSON.parse((await c.env.SESSION_KV.get(STATE_KEY)) || '{}');
  const hc = state.hardcore || { enabled: false, mode: 'wipe' };
  return c.json({ hardcore: hc });
});
app.post('/api/hardcore', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { enabled, mode } = body;
  if (typeof enabled !== 'boolean' && !mode) return c.json({ ok: false, error: '缺少参数 (enabled/mode)' });
  if (mode && !['wipe', 'ban'].includes(mode)) return c.json({ ok: false, error: 'mode 仅支持 wipe/ban' });
  await logAudit(c.env, 'admin', 'hardcore_set', JSON.stringify({ enabled, mode }));
  const r = await submitCmd(c.env, 'setHardcore', { enabled, mode });
  return c.json(r);
});

app.get('/api/config', async (c) => {
  const file = c.req.query('file') || 'server.properties';
  const r = await submitCmd(c.env, 'getConfig', { file });
  return c.json(r);
});
app.get('/api/config/files', async (c) => {
  const r = await submitCmd(c.env, 'getFiles', {});
  return c.json(r);
});
app.post('/api/config', async (c) => {
  const { file, key, value, restart } = await c.req.json();
  if (!file || !key) return c.json({ ok: false, error: '缺少 file/key' });
  const r = await submitCmd(c.env, 'setConfig', { file, key, value, restart: !!restart });
  return c.json(r);
});

// 审计日志
app.get('/api/audit', async (c) => {
  const rows = await c.env?.DB?.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all().catch(() => null);
  return c.json(rows?.results || []);
});

async function logAudit(env, actor, action, detail = '') {
  try { await env.DB.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?,?,?)').bind(actor, action, detail).run(); } catch {}
}

// ---------------- WebSocket (保留兼容; 主要通道已是 HTTP 轮询) ----------------
// 面板控制台实时日志: 面板 WS -> Agent 状态由 KV 驱动 (简化: 面板轮询 /api/logs)

// ---------------- 兜底 ----------------
app.get('/', () => new Response('MC1life API OK', { headers: { 'content-type': 'text/plain' } }));
app.notFound(() => Response.json({ ok: false, error: 'Not Found' }, { status: 404 }));

export default app;
