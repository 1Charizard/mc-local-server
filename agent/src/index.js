// MC1life Agent 入口 (v3 HTTP 轮询: 心跳上报状态+日志, 轮询拉指令, 回传结果)
const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_PATH = process.env.MC1LIFE_CONFIG || path.join(__dirname, '..', 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[MC1life] 缺少配置文件: ${CONFIG_PATH}`);
    console.error('  复制 config.json.example 为 config.json 并填写参数');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const config = loadConfig();
const BDS = require('./bds');
const RCON = require('./rcon');
const WS = require('./ws');
const Backup = require('./backup');
const Worlds = require('./worlds');
const Config = require('./config');
const Hardcore = require('./hardcore');

const rcon = new RCON(config.rcon);
const bds = new BDS(config.bds, { rcon });
const backup = new Backup(config.bds, config.r2, config.backup, bds, rcon);
const worlds = new Worlds(config.bds, bds);
const cfg = new Config(config.bds);
const hardcore = new Hardcore(config.hardcore, { bds, rcon, backup, send });
hardcore.start();

// 状态缓存
const state = {
  running: false,
  players: [],
  startedAt: null,
  version: '',
  mem: { rss: 0, heapUsed: 0 },
  cpu: 0,
  uptime: 0,
  world: '',
};

// 日志缓冲 (心跳时随状态上报)
let _logBatch = [];
let _logFlushTimer = null;

// 分片上传暂存 (兼容旧协议, 新版直接走 worldImportUpload)
const uploads = {};

// 轮询客户端: onMessage 处理两种事件:
//   {type:'status-request'} -> 返回状态对象 (心跳用)
//   {type:'drain-logs'}     -> 返回并清空日志缓冲
//   {type:'cmd', cmd}       -> 执行指令, 返回 {ok,result} 或 {ok:false,error}
const poll = new WS(config, {
  onMessage: async (msg) => {
    try {
      if (msg.type === 'status-request') return await collectStatus();
      if (msg.type === 'drain-logs') {
        const lines = _logBatch.slice();
        _logBatch = [];
        return lines;
      }
      if (msg.type === 'cmd' && msg.cmd) {
        const { id, kind, payload } = msg.cmd;
        try {
          const result = await dispatch(kind, payload || {});
          return { ok: true, result };
        } catch (err) {
          console.error('[MC1life] 指令失败:', kind, err.message);
          return { ok: false, error: err.message || String(err) };
        }
      }
      return null;
    } catch (e) {
      console.error('[MC1life] 轮询处理异常:', e.message);
      return { ok: false, error: e.message };
    }
  },
});

// 兼容 hardcore.send 的事件上报: 走日志输出 (Agent 侧可见), 不依赖 WS 推送
function send(type, data) {
  console.log(`[MC1life] event:${type}`, JSON.stringify(data).slice(0, 300));
  return true;
}

// ---------- 指令分发 ----------
async function dispatch(kind, p) {
  switch (kind) {
    case 'ping': return { pong: Date.now() };
    case 'status': return collectStatus();
    case 'logs': return { lines: bds.logBuffer.slice(-500), total: bds.logBuffer.length };
    case 'start': await bds.start(); return collectStatus();
    case 'stop': await bds.stop(); return collectStatus();
    case 'restart': await bds.restart(); return collectStatus();
    case 'exec': return await rcon.exec(p.command);
    case 'kick': return await rcon.exec(`kick "${p.name}" ${p.reason || ''}`.trim());
    case 'ban': return await rcon.exec(`ban "${p.name}" ${p.reason || ''}`.trim());
    case 'unban': return await rcon.exec(`unban "${p.name}"`.trim());
    case 'op': return await rcon.exec(`op "${p.name}"`.trim());
    case 'deop': return await rcon.exec(`deop "${p.name}"`.trim());
    case 'say': return await rcon.exec(`say ${p.message || ''}`);
    case 'list': return await rcon.exec('list');
    case 'listBackups': return await backup.list();
    case 'backup': return await backup.create(p.name || 'manual');
    case 'restore': return await backup.restore(p.backupId);
    case 'listWorlds': return await worlds.getCached();
    case 'deleteWorld': {
      const r = await worlds.delete(p.name);
      worlds.refreshCache();
      return r;
    }
    case 'switchWorld': {
      const r = await worlds.switchTo(p.name);
      worlds.refreshCache();
      return r;
    }
    case 'worldExport': return await exportWorld(p.name);
    case 'uploadWorld': return await worlds.upload(p.url, p.name);
    case 'getHardcore': return { enabled: !!config.hardcore?.enabled, mode: config.hardcore?.mode || 'wipe' };
    case 'setHardcore': {
      const hc = {
        enabled: typeof p.enabled === 'boolean' ? p.enabled : !!config.hardcore?.enabled,
        mode: p.mode || config.hardcore?.mode || 'wipe',
      };
      saveHardcoreConfig(hc);
      hardcore.update(hc);
      return { ok: true, hardcore: hc };
    }
    case 'worldImportUpload': return handleWorldImportUpload(p);
    case 'worldUploadChunk': return handleUploadChunk(p);
    case 'worldUploadFinish': return handleUploadFinish(p);
    case 'getConfig': return await cfg.getAll(p.file || 'server.properties');
    case 'setConfig': return await cfg.set(p.file || 'server.properties', p.key, p.value, { restart: !!p.restart });
    case 'getFiles': return await cfg.listFiles();
    case 'players': return await collectPlayers();
    default: throw new Error(`未知指令: ${kind}`);
  }
}

// ---------- 硬核配置持久化 ----------
function saveHardcoreConfig(hc) {
  config.hardcore = hc;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[MC1life] 硬核配置保存失败:', e.message);
  }
}

// ---------- 导出世界: 打包 -> 分片上传 Worker KV (不依赖 R2) ----------
async function exportWorld(worldName) {
  if (!worldName) throw new Error('缺少世界名');
  const worldDir = path.join(config.bds.worldDir, worldName);
  if (!fs.existsSync(path.join(worldDir, 'level.dat'))) {
    throw new Error(`世界不存在或无效: ${worldName}`);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const exportId = `exp_${Date.now().toString(36)}`;
  const tmpFile = `/tmp/mc1life_export_${Date.now()}.tar.gz`;

  // 1. 打包单个世界目录
  await new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile('tar', ['-czf', tmpFile, '--exclude=*.tmp', '--exclude=session.lock', worldName], { cwd: config.bds.worldDir, maxBuffer: 128 * 1024 * 1024 }, (err) => err ? reject(err) : resolve());
  });

  try {
    const full = fs.readFileSync(tmpFile);
    const size = full.length;
    // 2. 分片 base64 上传 Worker (每片 1.5MB, KV 单值上限 25MB 内)
    const CHUNK = 1536 * 1024;
    const total = Math.ceil(size / CHUNK);
    const base = poll._base();
    const auth = poll._auth();
    const reqMod = base.startsWith('https') ? require('https') : require('http');

    // 通知 Worker 开始导出会话 (meta)
    await new Promise((resolve, reject) => {
      const data = JSON.stringify({ exportId, worldName, totalChunks: total, size, fileName: `${worldName}_${ts}.tar.gz` });
      const req = reqMod.request(`${base}/api/agent/export/start?${auth}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 20000 }, (res) => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>{ try { const j=JSON.parse(b); j.ok ? resolve() : reject(new Error(j.error||'start fail')); } catch(e){ reject(new Error('响应解析失败')); } }); });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('start 超时')));
      req.write(data); req.end();
    });

    // 逐片上传
    for (let i = 0; i < total; i++) {
      const slice = full.slice(i * CHUNK, Math.min((i + 1) * CHUNK, size));
      const b64 = slice.toString('base64');
      await new Promise((resolve, reject) => {
        const data = JSON.stringify({ exportId, index: i, data: b64 });
        const req = reqMod.request(`${base}/api/agent/export/chunk?${auth}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 30000 }, (res) => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>{ try { const j=JSON.parse(b); j.ok ? resolve() : reject(new Error(j.error||'chunk fail')); } catch(e){ reject(new Error('响应解析失败')); } }); });
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error(`chunk ${i} 超时`)));
        req.write(data); req.end();
      });
      if (i % 5 === 0) console.log(`[MC1life] 导出上传分片 ${i + 1}/${total} (${(size/1048576).toFixed(1)}MB)`);
    }

    // 完成
    await new Promise((resolve, reject) => {
      const data = JSON.stringify({ exportId });
      const req = reqMod.request(`${base}/api/agent/export/complete?${auth}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 20000 }, (res) => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>{ try { const j=JSON.parse(b); j.ok ? resolve() : reject(new Error(j.error||'complete fail')); } catch(e){ reject(new Error('响应解析失败')); } }); });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('complete 超时')));
      req.write(data); req.end();
    });

    console.log(`[MC1life] 世界导出完成: ${worldName} (${(size/1048576).toFixed(1)}MB, ${total}片) -> ${exportId}`);
    return { exportId, world: worldName, size, ts, fileName: `${worldName}_${ts}.tar.gz`, ok: true };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ---------- 网页上传: 新版走 Agent 主动拉取 KV 分片 ----------
// Worker 端: upload 存 KV (meta + chunk:i), 入队 worldImportUpload
// Agent 端: 拉取指令后, 用 HTTP 拉取分片拼接导入
async function handleWorldImportUpload(p) {
  const { uploadId, fileName, worldName, totalChunks } = p || {};
  if (!uploadId || !totalChunks) throw new Error('缺少上传参数');
  console.log(`[MC1life] 拉取存档分片: ${uploadId} (${totalChunks} 片, ${fileName})`);
  // 从 Worker KV 拉取分片 (并发 8, 500MB 世界 ~334 片串行太慢)
  const base = poll._base();
  const mod = base.startsWith('https') ? require('https') : require('http');
  const fetchChunk = (i) => new Promise((resolve, reject) => {
    const req = mod.get(`${base}/api/agent/upload/${uploadId}/${i}?agent=${encodeURIComponent(config.agentId)}&token=${encodeURIComponent(config.token)}`, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error(`分片 ${i} 拉取超时`)));
  });
  const chunks = [];
  const CONC = 8;
  for (let i = 0; i < totalChunks; i += CONC) {
    const batch = [];
    for (let j = i; j < Math.min(i + CONC, totalChunks); j++) batch.push(fetchChunk(j));
    const results = await Promise.all(batch);
    results.forEach((r, idx) => {
      if (r.status !== 200) throw new Error(`分片 ${i + idx} 拉取失败 HTTP ${r.status}`);
      chunks[i + idx] = Buffer.from(r.body, 'base64');
    });
    if (i % 16 === 0) console.log(`[MC1life] 拉取分片 ${Math.min(i + CONC, totalChunks)}/${totalChunks}`);
  }
  const full = Buffer.concat(chunks);
  const dir = '/opt/mc1life/uploads';
  fs.mkdirSync(dir, { recursive: true });
  const ext = (fileName || 'world.zip').match(/\.(zip|tar\.gz|tgz|mcworld)$/i)?.[0] || '.zip';
  const tmpFile = `${dir}/upload_${Date.now()}${ext}`;
  fs.writeFileSync(tmpFile, full);
  console.log(`[MC1life] 存档分片拼接完成, ${(full.length / 1048576).toFixed(1)}MB -> ${tmpFile}`);
  try {
    const result = await worlds.importLocal(tmpFile, worldName || 'uploaded_world');
    console.log(`[MC1life] 存档导入完成: ${result.world}`);
    worlds.refreshCache();
    // 清理 KV 暂存分片
    try {
      await new Promise((resolve) => {
        const mod = base.startsWith('https') ? require('https') : require('http');
        const req = mod.request(`${base}/api/agent/upload/${uploadId}/cleanup?agent=${encodeURIComponent(config.agentId)}&token=${encodeURIComponent(config.token)}`, { method: 'POST' }, resolve);
        req.on('error', () => {});
        req.end();
      });
    } catch {}
    return { ok: true, world: result.world, note: bds.running ? '服务器运行中, 请在面板切换到该世界' : undefined };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ---------- 分片上传 (旧协议兼容) ----------
function handleUploadChunk(p) {
  const { uploadId, fileName, chunkIndex, totalChunks, data } = p || {};
  if (!uploadId || chunkIndex === undefined) throw new Error('缺少分片参数');
  if (!uploads[uploadId]) {
    uploads[uploadId] = { fileName: fileName || 'world.zip', chunks: [], totalChunks: totalChunks || 0, received: 0 };
  }
  const up = uploads[uploadId];
  const buf = Buffer.from(data || '', 'base64');
  up.chunks[chunkIndex] = buf;
  up.received++;
  return { ok: true, received: up.received, total: up.totalChunks };
}

async function handleUploadFinish(p) {
  const { uploadId, fileName, totalChunks } = p || {};
  const up = uploads[uploadId];
  if (!up) throw new Error('上传会话不存在');
  if (up.received !== up.totalChunks || up.chunks.some(c => !c)) {
    throw new Error(`分片不完整 (${up.received}/${up.totalChunks})`);
  }
  const full = Buffer.concat(up.chunks);
  const dir = '/opt/mc1life/uploads';
  fs.mkdirSync(dir, { recursive: true });
  const ext = (fileName || 'world.zip').match(/\.(zip|tar\.gz|tgz|mcworld)$/i)?.[0] || '.zip';
  const tmpFile = `${dir}/upload_${Date.now()}${ext}`;
  fs.writeFileSync(tmpFile, full);
  delete uploads[uploadId];
  console.log(`[MC1life] 收到存档分片 ${up.received} 片, ${(full.length / 1048576).toFixed(1)}MB -> ${tmpFile}`);
  const baseName = (fileName || 'uploaded_world').replace(/\.(zip|mcworld|tar\.gz|tgz)$/i, '');
  const safeName = baseName.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').slice(0, 60) || 'uploaded_world';
  try {
    const result = await worlds.importLocal(tmpFile, safeName);
    console.log(`[MC1life] 存档导入完成: ${result.world}`);
    worlds.refreshCache();
    return { ok: true, world: result.world, note: bds.running ? '服务器运行中, 请在面板切换到该世界' : undefined };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ---------- 状态采集 ----------
function collectMemCpu() {
  try {
    const m = process.memoryUsage();
    state.mem = { rss: Math.round(m.rss / 1048576), heapUsed: Math.round(m.heapUsed / 1048576) };
    const pid = bds.pid;
    if (pid) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.split(' ');
      const utime = Number(fields[13]), stime = Number(fields[14]);
      const total = utime + stime;
      const now = Date.now();
      if (bds._lastCpu && bds._lastCpuTime) {
        const dt = (now - bds._lastCpuTime) / 1000;
        state.cpu = Math.min(100, Math.round(((total - bds._lastCpu) / dt) * 100));
      }
      bds._lastCpu = total; bds._lastCpuTime = now;
    }
  } catch { /* proc 不可用时忽略 */ }
}

async function collectPlayers() {
  try {
    const out = await rcon.exec('list');
    const m = String(out).match(/There are (\d+)\/(\d+) players online:?\s*(.*)/i);
    if (m) {
      state.players = m[3] ? m[3].split(',').map(s => s.trim()).filter(Boolean) : [];
    }
  } catch { state.players = []; }
  return state.players;
}

async function collectStatus() {
  collectMemCpu();
  state.running = bds.running;
  state.uptime = bds.running && state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
  await collectPlayers();
  const props = await cfg.readProperties();
  state.world = props['level-name'] || '';
  return {
    agentId: config.agentId,
    running: state.running,
    players: state.players,
    maxPlayers: props['max-players'] || 20,
    onlineMode: props['online-mode'] !== 'false',
    world: state.world,
    version: state.version || (await bds.detectVersion()),
    uptime: state.uptime,
    mem: state.mem,
    cpu: state.cpu,
    hostname: os.hostname(),
    hardcore: { enabled: !!config.hardcore?.enabled, mode: config.hardcore?.mode || 'wipe' },
    worlds: await worlds.getCached(),
    ts: Date.now(),
  };
}

// BDS 进程事件
bds.on('started', async () => { state.startedAt = Date.now(); state.running = true; });
bds.on('stopped', async () => { state.running = false; state.startedAt = null; });
bds.on('crash', async (line) => { console.error('[MC1life] BDS 崩溃:', line); });

// 日志流: 缓冲后随心跳上报
bds.on('log', (line) => {
  if (!line) return;
  _logBatch.push(line);
  if (_logBatch.length > 200) { _logBatch.shift(); }
  const join = line.match(/Player connected: (.+?), xuid:/i);
  if (join && !state.players.includes(join[1])) state.players.push(join[1]);
  const leave = line.match(/Player disconnected: (.+?), xuid:/i);
  if (leave) state.players = state.players.filter(p => p !== leave[1]);
});

// 自动备份
if (config.backup.auto) {
  const ms = (config.backup.intervalMinutes || 360) * 60000;
  setInterval(async () => {
    try { await backup.create('auto'); } catch (e) { console.error('[MC1life] 自动备份失败', e.message); }
  }, ms);
}

// 启动
(async () => {
  console.log(`[MC1life] Agent 启动 (${config.agentId}), 轮询 ${config.workerUrl}`);
  console.log(`[MC1life] 硬核模式: ${config.hardcore?.enabled ? 'ON (' + (config.hardcore.mode || 'wipe') + ')' : 'OFF'}`);
  worlds.refreshCache();
  if (!bds.running) {
    console.log('[MC1life] BDS 未运行, 自动启动...');
    try { await bds.start(); } catch (e) { console.error('[MC1life] 自动启动失败', e.message); }
  }
  poll.connect();
})();
