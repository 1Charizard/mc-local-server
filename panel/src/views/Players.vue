<template>
  <div class="page">
    <h2>👥 玩家管理</h2>

    <div class="panel">
      <h3>在线玩家</h3>
      <div v-if="!online.length" class="empty">暂无在线玩家</div>
      <table v-else>
        <thead><tr><th>玩家名</th><th v-if="isAdmin">操作</th></tr></thead>
        <tbody>
          <tr v-for="p in online" :key="p">
            <td>{{ p }}</td>
            <td v-if="isAdmin" class="ops">
              <button class="mini warn" @click="doAction('kick', { name: p })">踢出</button>
              <button class="mini danger" @click="openBan(p)">封禁</button>
              <button class="mini ok" @click="doAction('op', { name: p })">授予OP</button>
              <button class="mini" @click="doAction('deop', { name: p })">撤销OP</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h3>执行玩家操作</h3>
      <div v-if="isAdmin" class="row">
        <input v-model="target" placeholder="输入玩家名" />
        <button class="mini warn" @click="doAction('kick', { name: target })">踢出</button>
        <button class="mini danger" @click="openBan(target)">封禁</button>
        <button class="mini ok" @click="doUnban(target)">解封</button>
        <button class="mini ok" @click="doAction('op', { name: target })">授予OP</button>
        <button class="mini" @click="doAction('deop', { name: target })">撤销OP</button>
      </div>
      <p v-else class="tip">当前为访客模式（只读），无法操作玩家。</p>
    </div>

    <div class="panel">
      <h3>🚫 封禁列表 <span class="cnt" v-if="bans.length">{{ bans.length }} 条</span></h3>
      <p class="tip" style="margin-top:-4px">封禁基于白名单（allow-list）实现：永久/限时封禁即刻踢出并禁止重连；到期自动解封并加回白名单。</p>
      <div v-if="!bans.length" class="empty">暂无封禁记录</div>
      <table v-else>
        <thead><tr><th>玩家</th><th>原因</th><th>封禁时间</th><th>到期/状态</th><th v-if="isAdmin">操作</th></tr></thead>
        <tbody>
          <tr v-for="b in bans" :key="b.xuid || b.name">
            <td>{{ b.name }}<span v-if="b.xuid" class="mono"><br/>xuid {{ b.xuid }}</span></td>
            <td>{{ b.reason || '—' }}</td>
            <td>{{ fmtTime(b.bannedAt) }}</td>
            <td>
              <span v-if="b.status === 'permanent'" class="tag danger">永久</span>
              <span v-else-if="b.status === 'temporary'" class="tag warn">至 {{ fmtTime(b.until) }}<br/><small>{{ fmtLeft(b.remainingMs) }}</small></span>
              <span v-else class="tag">已到期</span>
            </td>
            <td v-if="isAdmin" class="ops">
              <button class="mini ok" @click="doUnban(b.name || b.xuid)">解封</button>
              <button class="mini" @click="openSetTime(b)">改时间</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 封禁弹窗 -->
    <div v-if="showBan" class="modal-mask" @click.self="closeBan">
      <div class="modal">
        <h3>🚫 封禁玩家</h3>
        <div class="form">
          <label>玩家名</label>
          <input v-model="banForm.name" placeholder="玩家名 / XUID" />
          <label>原因（可选）</label>
          <input v-model="banForm.reason" placeholder="封禁原因" />
          <label>封禁时长</label>
          <div class="radio-row">
            <label><input type="radio" value="perm" v-model="banForm.type" /> 永久封禁</label>
            <label><input type="radio" value="temp" v-model="banForm.type" /> 限时封禁</label>
          </div>
          <div v-if="banForm.type === 'temp'" class="row tight">
            <input type="number" v-model="banForm.days" min="0" style="max-width:80px" /> 天
            <input type="number" v-model="banForm.hours" min="0" max="23" style="max-width:80px" /> 小时
            <input type="number" v-model="banForm.mins" min="0" max="59" style="max-width:80px" /> 分钟
          </div>
        </div>
        <div class="modal-actions">
          <button class="mini" @click="closeBan">取消</button>
          <button class="mini danger" :disabled="!banForm.name || submitting" @click="submitBan">
            {{ submitting ? '提交中...' : '确认封禁' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 改时间弹窗 -->
    <div v-if="showTime" class="modal-mask" @click.self="closeTime">
      <div class="modal">
        <h3>⏱️ 修改封禁时间</h3>
        <div class="form">
          <p class="tip">玩家: <b>{{ timeForm.name }}</b>（当前：{{ timeForm.current }}）</p>
          <label>新封禁时长</label>
          <div class="radio-row">
            <label><input type="radio" value="perm" v-model="timeForm.type" /> 改为永久</label>
            <label><input type="radio" value="temp" v-model="timeForm.type" /> 改为限时</label>
            <label><input type="radio" value="now" v-model="timeForm.type" /> 立即到期（解封）</label>
          </div>
          <div v-if="timeForm.type === 'temp'" class="row tight">
            <input type="number" v-model="timeForm.days" min="0" style="max-width:80px" /> 天
            <input type="number" v-model="timeForm.hours" min="0" max="23" style="max-width:80px" /> 小时
            <input type="number" v-model="timeForm.mins" min="0" max="59" style="max-width:80px" /> 分钟
          </div>
        </div>
        <div class="modal-actions">
          <button class="mini" @click="closeTime">取消</button>
          <button class="mini danger" :disabled="submitting" @click="submitTime">{{ submitting ? '提交中...' : '确认修改' }}</button>
        </div>
      </div>
    </div>

    <div class="panel" v-if="result">
      <h3>执行结果</h3>
      <pre class="result">{{ result }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getPlayers, playerAction, banPlayer, unbanPlayer, getBans, setBanTime, getRole } from '../api';

const online = ref([]);
const bans = ref([]);
const target = ref('');
const result = ref('');
const isAdmin = getRole() === 'admin';
const showBan = ref(false);
const showTime = ref(false);
const submitting = ref(false);
const banForm = ref({ name: '', reason: '', type: 'perm', days: 0, hours: 0, mins: 0 });
const timeForm = ref({ name: '', key: '', current: '', type: 'perm', days: 0, hours: 0, mins: 0 });

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
function fmtLeft(ms) {
  if (!ms || ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}天${h}小时` : h ? `${h}小时${m}分` : `${m}分钟`;
}
function durationMs(f) {
  return ((Number(f.days) || 0) * 86400 + (Number(f.hours) || 0) * 3600 + (Number(f.mins) || 0) * 60) * 1000;
}

async function refresh() {
  try { const r = await getPlayers(); online.value = Array.isArray(r.result) ? r.result : []; }
  catch { online.value = []; }
  if (isAdmin) {
    try { bans.value = await getBans(); } catch { bans.value = []; }
  }
}
async function doAction(kind, { name }) {
  if (!name) return;
  const reason = prompt(`理由 (可选, 用于 ${kind})`) || '';
  try {
    const r = await playerAction(kind, { name, reason });
    result.value = JSON.stringify(r.result || r || '完成');
  } catch (e) { result.value = `错误: ${e.message}`; }
  refresh();
}
// 封禁流程
function openBan(name) {
  if (!name) return;
  banForm.value = { name, reason: '', type: 'perm', days: 0, hours: 0, mins: 0 };
  showBan.value = true;
}
function closeBan() { showBan.value = false; }
async function submitBan() {
  const f = banForm.value;
  if (!f.name.trim()) return;
  submitting.value = true;
  try {
    const until = f.type === 'temp' ? Date.now() + durationMs(f) : null;
    if (until && until <= Date.now()) throw new Error('限时封禁时长需大于 0');
    const r = await banPlayer(f.name.trim(), f.reason, until);
    result.value = (r.ok === false ? `封禁失败: ${r.error}` : `✅ 已封禁 ${f.name.trim()}${until ? '（限时）' : '（永久）'}`);
    closeBan();
    refresh();
  } catch (e) { result.value = `错误: ${e.message}`; }
  submitting.value = false;
}
async function doUnban(nameOrXuid) {
  if (!nameOrXuid) return;
  if (!confirm(`确定解封「${nameOrXuid}」？将移除封禁并加回白名单。`)) return;
  try {
    const r = await unbanPlayer(nameOrXuid);
    result.value = (r.ok === false ? `解封失败: ${r.error}` : `✅ 已解封 ${nameOrXuid}`);
    refresh();
  } catch (e) { result.value = `错误: ${e.message}`; }
}
// 修改封禁时间
function openSetTime(b) {
  timeForm.value = {
    name: b.name, key: b.xuid || b.name,
    current: b.status === 'permanent' ? '永久' : (b.until ? fmtTime(b.until) : '永久'),
    type: b.status === 'permanent' ? 'perm' : 'temp',
    days: 0, hours: 0, mins: 0,
  };
  showTime.value = true;
}
function closeTime() { showTime.value = false; }
async function submitTime() {
  const f = timeForm.value;
  submitting.value = true;
  try {
    let until;
    if (f.type === 'temp') {
      until = Date.now() + durationMs(f);
      if (until <= Date.now()) throw new Error('限时封禁时长需大于 0');
    } else if (f.type === 'perm') {
      until = null;           // 永久
    } else {
      until = 0;              // 立即到期 -> Agent 转 unban 解封
    }
    const r = await setBanTime(f.key, until);
    result.value = (r.ok === false ? `修改失败: ${r.error}` : `✅ 已更新「${f.name}」的封禁时间`);
    closeTime();
    refresh();
  } catch (e) { result.value = `错误: ${e.message}`; }
  submitting.value = false;
}
onMounted(refresh);
</script>

<style scoped>
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f3f4f6; font-size: 13.5px; vertical-align: top; }
.mono { font-family: ui-monospace, monospace; font-size: 11.5px; color: #6b7280; }
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
.cnt { font-size: 12px; color: #6b7280; font-weight: normal; }
.mini { padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
.mini.ok { color: #15803d; border-color: #86efac; }
.mini.warn { color: #b45309; border-color: #fcd34d; }
.mini.danger { color: #b91c1c; border-color: #fca5a5; }
.mini:disabled { opacity: .4; cursor: not-allowed; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row.tight { margin-top: 6px; font-size: 13px; color: #374151; }
.row input:not([type=file]):not([type=radio]) { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; max-width: 280px; }
.row input[type=number] { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
.tag { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #f3f4f6; color: #6b7280; }
.tag.danger { background: #fee2e2; color: #b91c1c; }
.tag.warn { background: #fef3c7; color: #b45309; }
.tag small { font-weight: normal; }
.result { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; font-size: 12.5px; white-space: pre-wrap; }
.empty { color: #9ca3af; padding: 14px; }
.tip { color: #6b7280; font-size: 12.5px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: #fff; border-radius: 14px; padding: 22px; width: min(440px, 92vw); box-shadow: 0 10px 40px rgba(0,0,0,.25); }
.modal h3 { margin-top: 0; }
.form label { display: block; font-size: 13px; color: #374151; margin: 12px 0 4px; }
.form input:not([type=radio]) { width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
.radio-row { display: flex; gap: 16px; font-size: 14px; color: #374151; }
.radio-row label { display: flex; align-items: center; gap: 4px; margin: 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
</style>
