// 面板 API 封装 v2 (双密码角色 + 硬核 + 文件上传)
const API_BASE = import.meta.env.VITE_API_BASE || '';
const TOKEN_KEY = 'mc1life_panel_token';
const ROLE_KEY = 'mc1life_panel_role';

export function getAuthToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
export function setAuthToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function getRole() { return localStorage.getItem(ROLE_KEY) || ''; }
export function setRole(r) { localStorage.setItem(ROLE_KEY, r); }
export function clearAuthToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ROLE_KEY); }

async function req(path, opts = {}) {
    // FormData 上传时不手动设 Content-Type (浏览器自动带 multipart boundary)
    const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
    const headers = { ...(opts.headers || {}) };
    if (!isForm) headers['Content-Type'] = 'application/json';
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { headers, ...opts });
  if (res.status === 401) {
    clearAuthToken();
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('未授权，请先登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// 登录: 用密码换取角色 (admin/viewer)
export async function loginWithPassword(pass) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${pass}` };
  const res = await fetch(`${API_BASE}/api/auth`, { method: 'POST', headers });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 200 || data.ok !== true) throw new Error('密码错误');
  setAuthToken(pass);
  setRole(data.role);
  return data.role;
}

export const getStatus = async () => {
  // Agent 离线时 Worker 返回 {ok:false, agent:'offline'}, 面板需展示离线态而非报错
  const token = getAuthToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/status`, { headers });
  const data = await res.json().catch(() => ({}));
  if (data.ok === false && data.agent === 'offline') {
    return { agent: 'offline', running: false, players: [], hardcore: null };
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
};
export const getLogs = (after) => req(`/api/logs${after ? `?after=${after}` : ''}`);
export const sendCmd = (command) => req('/api/cmd', { method: 'POST', body: JSON.stringify({ command }) });
export const serverAction = (action) => req(`/api/server/${action}`, { method: 'POST' });
export const getPlayers = () => req('/api/players');
export const playerAction = (action, payload) => req(`/api/players/${action}`, { method: 'POST', body: JSON.stringify(payload) });
export const getBackups = () => req('/api/backups');
export const createBackup = (name) => req('/api/backups', { method: 'POST', body: JSON.stringify({ name }) });
export const restoreBackup = (backupId) => req('/api/backups/restore', { method: 'POST', body: JSON.stringify({ backupId }) });
export const getWorlds = () => req('/api/worlds');
export const switchWorld = (name) => req('/api/worlds/switch', { method: 'POST', body: JSON.stringify({ name }) });
export const deleteWorld = (name) => req('/api/worlds/delete', { method: 'POST', body: JSON.stringify({ name }) });
export const exportWorld = (name) => req('/api/worlds/export', { method: 'POST', body: JSON.stringify({ name }) });
export const exportWorldUrl = (id) => `${API_BASE}/api/worlds/export/meta?id=${encodeURIComponent(id)}`;
// 下载导出存档: 循环拉 base64 分片 -> 前端拼 Blob 下载 (绕开 Worker CPU 限制)
export async function downloadExport(id) {
  const metaRes = await req(`/api/worlds/export/meta?id=${encodeURIComponent(id)}`);
  const meta = metaRes.meta || metaRes;
  let b64 = '';
  for (let i = 0; i < meta.totalChunks; i++) {
    const res = await fetch(`${API_BASE}/api/worlds/export/chunk?id=${encodeURIComponent(id)}&i=${i}`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });
    if (!res.ok) throw new Error(`分片 ${i + 1}/${meta.totalChunks} 下载失败`);
    b64 += await res.text();
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/gzip' });
  return { blob, fileName: meta.fileName || 'world.tar.gz' };
}
export const uploadWorld = (url, name) => req('/api/worlds/upload', { method: 'POST', body: JSON.stringify({ url, name }) });
// 网页上传存档 (multipart, 分片经 Worker WS 直传 Agent)
// 前端分片上传存档 (绕开 CF 100MB 单请求限制, 上限 500MB; 每片失败自动重试 3 次)
export async function uploadWorldFile(file, name, onProgress) {
  const MAX = 500 * 1024 * 1024;
  const CHUNK = 1536 * 1024;
  if (file.size > MAX) throw new Error(`文件过大 (${(file.size/1048576).toFixed(1)}MB), 上限 500MB`);
  if (file.size === 0) throw new Error('文件为空');
  const fileName = (name || file.name || 'world.zip').replace(/[\\/:*?"<>|]/g, '');
  // 1. start
  const st = await req('/api/worlds/upload/start', { method: 'POST', body: JSON.stringify({ fileName: file.name || 'world.zip', size: file.size }) });
  const { uploadId, totalChunks } = st;
  const token = getAuthToken();
  // 2. 逐片二进制上传 (失败重试 3 次, 60s 超时, 防弱网抖动中断)
  for (let i = 0; i < totalChunks; i++) {
    const slice = file.slice(i * CHUNK, Math.min((i + 1) * CHUNK, file.size));
    const buf = await slice.arrayBuffer();
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 60000);
        const res = await fetch(`${API_BASE}/api/worlds/upload/chunk?id=${uploadId}&i=${i}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: buf,
          signal: ac.signal,
        });
        clearTimeout(timer);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || `分片 ${i + 1}/${totalChunks} 上传失败`);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1000 * attempt)); // 退避 1s/2s
          if (onProgress) onProgress(Math.round(((i) / totalChunks) * 95), i, totalChunks); // 显示重试中
        }
      }
    }
    if (lastErr) throw new Error(`分片 ${i + 1}/${totalChunks} 上传失败: ${lastErr.message} (已重试 3 次, 请检查网络后重试)`);
    if (onProgress) onProgress(Math.round(((i + 1) / totalChunks) * 95), i + 1, totalChunks);
  }
  // 3. finish (提交导入, 后台处理)
  const fin = await req('/api/worlds/upload/finish', { method: 'POST', body: JSON.stringify({ uploadId }) });
  if (onProgress) onProgress(100, totalChunks, totalChunks);
    // 附带 start 阶段的 worldName (供前端轮询判断新世界是否出现)
    return { ...fin, worldName: st.worldName };
}
export const getHardcore = () => req('/api/hardcore');
export const setHardcore = (enabled, mode) => req('/api/hardcore', { method: 'POST', body: JSON.stringify({ enabled, mode }) });
export const getConfig = (file) => req(`/api/config?file=${encodeURIComponent(file || 'server.properties')}`);
export const getConfigFiles = () => req('/api/config/files');
export const setConfig = (file, key, value, restart) => req('/api/config', { method: 'POST', body: JSON.stringify({ file, key, value, restart }) });

export function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getAuthToken();
  return new WebSocket(`${proto}://${location.host}/ws/panel?token=${encodeURIComponent(token)}`);
}
