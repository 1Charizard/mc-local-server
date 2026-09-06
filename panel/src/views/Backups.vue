<template>
  <div class="page">
    <h2>💾 备份回滚</h2>

    <!-- 手动备份（独立功能） -->
    <div class="panel" v-if="isAdmin">
      <h3>📦 手动备份（全量世界存档）</h3>
      <div class="row">
        <button class="btn ok" :disabled="busy" @click="doBackup">立即创建备份</button>
        <span class="tip">打包整个世界目录（含所有玩家个人数据），上传到 Cloudflare 存储。另有每 6 小时自动定时备份。</span>
      </div>
    </div>

    <!-- 手动/自动备份列表 -->
    <div class="panel">
      <h3>📚 手动 / 定时备份 <span class="cnt">{{ normalList.length }} 份</span></h3>
      <div v-if="!normalList.length" class="empty">暂无备份。点击「立即创建备份」生成第一份。</div>
      <table v-else>
        <thead><tr><th>类型</th><th>创建时间</th><th>大小</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in normalList" :key="b.backupId">
            <td><span class="tag" :class="b.kind === 'manual' ? 'manual' : 'auto'">{{ b.kind === 'manual' ? '手动' : '定时' }}</span></td>
            <td>{{ fmtTime(b.ts) }}</td>
            <td>{{ fmtSize(b.size) }}</td>
            <td class="ops">
              <template v-if="isAdmin">
                <button class="mini danger" :disabled="busy" @click="doRestore(b)">⏪ 回滚到此备份</button>
                <button class="mini" :disabled="busy" @click="doDelete(b)">删除</button>
              </template>
              <span v-else class="tip">只读</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 玩家死亡自动备份 -->
    <div class="panel">
      <h3>☠️ 玩家死亡自动备份（个人数据） <span class="cnt">{{ deathList.length }} 份</span></h3>
      <p class="tip">玩家死亡瞬间自动保存的世界快照，含该玩家背包/血量/Buff/坐标/基地。可在「⚙️ 服务器设置 → 玩家死亡自动备份」独立开启/关闭。恢复 = 将整个服务器世界回滚到该玩家死亡前的状态。</p>
      <div v-if="!deathList.length" class="empty">暂无死亡备份。开启功能后，每次玩家死亡会自动生成。</div>
      <table v-else>
        <thead><tr><th>玩家</th><th>死亡原因</th><th>死亡时间</th><th>大小</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in deathList" :key="b.backupId">
            <td class="pname">☠ {{ b.player || b.name.replace(/^death-/, '') }}</td>
            <td class="reason">{{ b.reason || '—' }}</td>
            <td>{{ fmtTime(b.ts) }}</td>
            <td>{{ fmtSize(b.size) }}</td>
            <td class="ops">
              <template v-if="isAdmin">
                <button class="mini danger" :disabled="busy" @click="doRestore(b)">♻️ 恢复（回滚到死亡前）</button>
                <button class="mini" :disabled="busy" @click="doDelete(b)">删除</button>
              </template>
              <span v-else class="tip">只读</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel" v-if="result">
      <h3>结果</h3>
      <pre class="result">{{ result }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { getBackups, createBackup, restoreBackup, deleteBackup, getRole } from '../api';

const backups = ref([]);
const result = ref('');
const busy = ref(false);
const isAdmin = getRole() === 'admin';

const normalList = computed(() => backups.value.filter(b => b.kind !== 'death'));
const deathList = computed(() => backups.value.filter(b => b.kind === 'death').sort((a, b) => (b.ts || 0) - (a.ts || 0)));

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
function fmtSize(b) {
  if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
async function refresh() {
  try { backups.value = (await getBackups()).result || []; }
  catch (e) { result.value = `加载失败: ${e.message}`; }
}
async function doBackup() {
  busy.value = true; result.value = '正在创建备份（先暂停世界写入，随后自动恢复）...';
  try {
    const r = await createBackup('manual');
    result.value = (r.ok === false ? `创建失败: ${r.error}` : `✅ 手动备份完成: ${r.result?.backupId || ''}`);
  } catch (e) { result.value = `错误: ${e.message}`; }
  busy.value = false; refresh();
}
async function doRestore(b) {
  const label = b.kind === 'death' ? `恢复「${b.player}」到死亡前` : '回滚到此备份';
  if (!confirm(`⚠️ 确定${label}？\n\n服务器会停止 → 将世界替换为该备份内容 → 重启。\n此后发生的所有改动（其他玩家进度/建筑）都会丢失！\n\n${b.backupId}`)) return;
  busy.value = true; result.value = '正在回滚（停服→解压→重启，可能需要几分钟）...';
  try {
    const r = await restoreBackup(b.backupId);
    result.value = (r.ok === false ? `回滚失败: ${r.error}` : `✅ 回滚完成: ${r.result?.restored || b.backupId}`);
  } catch (e) { result.value = `错误: ${e.message}`; }
  busy.value = false; refresh();
}
async function doDelete(b) {
  if (!confirm(`确定删除备份「${b.backupId}」？删除后不可恢复。`)) return;
  busy.value = true;
  try {
    const r = await deleteBackup(b.backupId);
    result.value = (r.ok === false ? `删除失败: ${r.error}` : '✅ 已删除');
  } catch (e) { result.value = `错误: ${e.message}`; }
  busy.value = false; refresh();
}
onMounted(refresh);
</script>

<style scoped>
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.btn { padding: 9px 18px; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; color: #fff; background: #22c55e; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.tip { color: #6b7280; font-size: 12.5px; }
.cnt { font-size: 12px; color: #6b7280; font-weight: normal; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f3f4f6; font-size: 13.5px; vertical-align: middle; }
.pname { font-weight: 600; color: #b91c1c; }
.reason { color: #374151; max-width: 340px; }
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { padding: 2px 10px; border-radius: 999px; font-size: 12px; }
.tag.manual { background: #dbeafe; color: #1d4ed8; }
.tag.auto { background: #f3f4f6; color: #6b7280; }
.mini { padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
.mini.ok { color: #15803d; border-color: #86efac; }
.mini.danger { color: #b91c1c; border-color: #fca5a5; }
.mini:disabled { opacity: .4; cursor: not-allowed; }
.result { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; font-size: 12.5px; white-space: pre-wrap; }
.empty { color: #9ca3af; padding: 14px; }
</style>
