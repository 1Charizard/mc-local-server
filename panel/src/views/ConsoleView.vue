<template>
  <div class="page">
    <h2>💻 控制台</h2>
    <div class="console-box">
      <div ref="logEl" class="log-area">
        <div v-for="(l, i) in logs" :key="i" class="log-line" :class="logClass(l)">{{ l }}</div>
        <div v-if="!logs.length" class="empty">暂无日志输出</div>
      </div>
      <form v-if="isAdmin" class="cmd-row" @submit.prevent="submit">
        <input v-model="cmd" placeholder="输入指令，如 say 大家好 / kick Alex / give Steve 1" autocomplete="off" />
        <button type="submit" :disabled="!cmd.trim()">发送</button>
      </form>
      <div v-else class="cmd-readonly">访客模式（只读），无法发送指令</div>
    </div>
    <div class="hint">
      常用指令: <code>list</code> · <code>say 内容</code> · <code>kick 玩家</code> ·
      <code>ban 玩家 理由</code> · <code>op 玩家</code> · <code>give 玩家 物品 数量</code> ·
      <code>time set day</code> · <code>weather clear</code> · <code>save hold/resume</code>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import { getLogs, sendCmd, connectWS, getRole } from '../api';

const logs = ref([]);
const cmd = ref('');
const logEl = ref(null);
const isAdmin = getRole() === 'admin';
let ws = null;

function logClass(l) {
  if (l.includes('[error]') || l.includes('ERROR')) return 'err';
  if (l.includes('[warn]') || l.includes('WARN')) return 'warn';
  return '';
}

function append(lines) {
  logs.value.push(...lines);
  if (logs.value.length > 800) logs.value = logs.value.slice(-800);
  nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
}

async function submit() {
  const c = cmd.value.trim();
  if (!c) return;
  append([`> ${c}`]);
  cmd.value = '';
  try { const r = await sendCmd(c); if (r.result) append(String(r.result).split('\n').filter(Boolean)); }
  catch (e) { append([`[错误] ${e.message}`]); }
}

onMounted(async () => {
  try { const r = await getLogs(); if (r.lines) append(r.lines); } catch {}
  try {
    ws = connectWS();
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'log' && msg.data?.lines) append(msg.data.lines);
      } catch {}
    };
  } catch {}
});
onUnmounted(() => { try { ws?.close(); } catch {} });
</script>

<style scoped>
.console-box { background: #0f172a; border-radius: 12px; overflow: hidden; margin-top: 16px; }
.log-area { height: 480px; overflow-y: auto; padding: 14px; font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; line-height: 1.7; color: #cbd5e1; }
.log-line { white-space: pre-wrap; word-break: break-all; }
.log-line.err { color: #f87171; }
.log-line.warn { color: #fbbf24; }
.cmd-row { display: flex; border-top: 1px solid #1e293b; }
.cmd-row input { flex: 1; background: #1e293b; border: none; color: #f1f5f9; padding: 12px 14px; font-size: 14px; outline: none; font-family: inherit; }
.cmd-row button { background: #3b82f6; border: none; color: #fff; padding: 0 22px; cursor: pointer; font-size: 14px; }
.cmd-row button:disabled { opacity: .5; cursor: not-allowed; }
.cmd-readonly { border-top: 1px solid #1e293b; padding: 12px 14px; color: #64748b; font-size: 13px; text-align: center; }
.hint { margin-top: 12px; color: #6b7280; font-size: 12.5px; }
.hint code { background: #e5e7eb; border-radius: 4px; padding: 1px 6px; }
.empty { color: #475569; text-align: center; padding-top: 60px; }
</style>
