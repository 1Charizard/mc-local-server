<template>
  <div class="page">
    <h2>💾 备份回滚</h2>
    <div class="panel" v-if="isAdmin">
      <div class="row">
        <button class="btn ok" :disabled="busy" @click="doBackup">立即创建备份</button>
        <span class="tip">备份会打包全部世界目录并上传到 Cloudflare R2（自动保留最近 5 份）</span>
      </div>
    </div>
    <div class="panel">
      <h3>备份列表</h3>
      <div v-if="!backups.length" class="empty">暂无备份</div>
      <table v-else>
        <thead><tr><th>类型</th><th>创建时间</th><th>大小</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in backups" :key="b.backupId">
            <td>
              <span v-if="isPreDeath(b)" class="tag pre">☠ 死亡前备份</span>
              <span v-else class="tag" :class="b.name === 'manual' ? 'manual' : 'auto'">{{ b.name === 'manual' ? '手动' : '自动' }}</span>
            </td>
            <td>{{ new Date(b.lastModified).toLocaleString() }}</td>
            <td>{{ fmtSize(b.size) }}</td>
            <td>
              <button v-if="isAdmin" class="mini danger" :disabled="busy" @click="doRestore(b.backupId)">回滚到此备份</button>
              <span v-else class="tip">只读</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="tip" v-if="hasPreDeath">☠ 死亡前备份 = 极限模式玩家死亡删档前自动生成的存档，可用于恢复被删档玩家的世界。</p>
    </div>
    <div class="panel" v-if="result">
      <h3>结果</h3>
      <pre class="result">{{ result }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { getBackups, createBackup, restoreBackup, getRole } from '../api';

const backups = ref([]);
const result = ref('');
const busy = ref(false);
const isAdmin = getRole() === 'admin';

function isPreDeath(b) { return (b.name || '').startsWith('pre-death-'); }
const hasPreDeath = computed(() => backups.value.some(isPreDeath));

function fmtSize(b) {
  if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
async function refresh() { try { backups.value = (await getBackups()).result || []; } catch (e) { result.value = `加载失败: ${e.message}`; } }
async function doBackup() {
  busy.value = true; result.value = '正在创建备份...';
  try { result.value = JSON.stringify(await createBackup('manual')); } catch (e) { result.value = `错误: ${e.message}`; }
  busy.value = false; refresh();
}
async function doRestore(id) {
  if (!confirm('确定回滚到此备份？服务器会停止、替换存档并重启，当前进度将丢失！')) return;
  busy.value = true; result.value = '正在回滚...';
  try { result.value = JSON.stringify(await restoreBackup(id)); } catch (e) { result.value = `错误: ${e.message}`; }
  busy.value = false; refresh();
}
onMounted(refresh);
</script>

<style scoped>
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.row { display: flex; align-items: center; gap: 12px; }
.btn { padding: 9px 18px; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; color: #fff; background: #22c55e; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.tip { color: #6b7280; font-size: 12.5px; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
.tag { padding: 2px 10px; border-radius: 999px; font-size: 12px; }
.tag.manual { background: #dbeafe; color: #1d4ed8; }
.tag.auto { background: #f3f4f6; color: #6b7280; }
.tag.pre { background: #fee2e2; color: #b91c1c; font-weight: 600; }
.mini { padding: 4px 10px; border: 1px solid #fca5a5; border-radius: 6px; background: #fff; color: #b91c1c; font-size: 12px; cursor: pointer; }
.mini:disabled { opacity: .4; cursor: not-allowed; }
.result { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; font-size: 12.5px; white-space: pre-wrap; }
.empty { color: #9ca3af; padding: 14px; }
</style>
