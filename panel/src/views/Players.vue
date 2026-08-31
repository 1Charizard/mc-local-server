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
              <button class="mini danger" @click="doAction('ban', { name: p })">封禁</button>
              <button class="mini ok" @click="doAction('op', { name: p })">授予OP</button>
              <button class="mini" @click="doAction('deop', { name: p })">撤销OP</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="panel" v-if="isAdmin">
      <h3>执行玩家操作</h3>
      <div class="row">
        <input v-model="target" placeholder="输入玩家名" />
        <button class="mini warn" @click="doAction('kick', { name: target })">踢出</button>
        <button class="mini danger" @click="doAction('ban', { name: target })">封禁</button>
        <button class="mini ok" @click="doAction('unban', { name: target })">解封</button>
        <button class="mini ok" @click="doAction('op', { name: target })">授予OP</button>
        <button class="mini" @click="doAction('deop', { name: target })">撤销OP</button>
      </div>
    </div>
    <div class="panel" v-else>
      <h3>执行玩家操作</h3>
      <p class="tip">当前为访客模式（只读），无法操作玩家。</p>
    </div>
    <div class="panel" v-if="result">
      <h3>执行结果</h3>
      <pre class="result">{{ result }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getPlayers, playerAction, getRole } from '../api';

const online = ref([]);
const target = ref('');
const result = ref('');
const isAdmin = getRole() === 'admin';

async function refresh() {
  try { const r = await getPlayers(); online.value = Array.isArray(r.result) ? r.result : []; }
  catch { online.value = []; }
}
async function doAction(kind, { name }) {
  if (!name) return;
  const reason = prompt(`理由 (可选, 用于 ${kind})`) || '';
  try {
    const r = await playerAction(kind, { name, reason });
    result.value = r.result || '完成';
  } catch (e) { result.value = `错误: ${e.message}`; }
  refresh();
}
onMounted(refresh);
</script>

<style scoped>
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
.ops { display: flex; gap: 6px; }
.mini { padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
.mini.ok { color: #15803d; border-color: #86efac; }
.mini.warn { color: #b45309; border-color: #fcd34d; }
.mini.danger { color: #b91c1c; border-color: #fca5a5; }
.row { display: flex; gap: 8px; align-items: center; }
.row input { flex: 1; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; max-width: 280px; }
.result { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; font-size: 12.5px; white-space: pre-wrap; }
.empty { color: #9ca3af; padding: 14px; }
.tip { color: #6b7280; font-size: 13px; }
</style>
