<template>
  <div class="page">
    <h2>🗺️ 存档管理</h2>
    <div class="panel">
      <h3>世界列表</h3>
      <div v-if="!worlds.length" class="empty">暂无世界</div>
      <table v-else>
        <thead><tr><th>世界名</th><th>大小</th><th>最后修改</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="w in worlds" :key="w.name">
            <td>{{ w.name }}</td>
            <td>{{ fmtSize(w.size) }}</td>
            <td>{{ new Date(w.mtime).toLocaleString() }}</td>
            <td><span class="tag" :class="w.isCurrent ? 'cur' : ''">{{ w.isCurrent ? '当前使用' : (w.hasLevelDat ? '可用' : '⚠️ 无 level.dat') }}</span></td>
            <td class="ops">
              <button v-if="isAdmin" class="mini ok" :disabled="w.isCurrent || !w.hasLevelDat" @click="doSwitch(w.name)">切换到此世界</button>
              <button v-if="isAdmin" class="mini" :disabled="!w.hasLevelDat" @click="doExport(w.name)">⬇️ 导出</button>
              <button v-if="isAdmin" class="mini" :disabled="!w.hasLevelDat" @click="doRename(w.name)">✏️ 重命名</button>
              <button v-if="isAdmin" class="mini" :disabled="!w.hasLevelDat" @click="goPacks(w.name)">🧩 包</button>
              <button v-if="isAdmin" class="mini danger" :disabled="w.isCurrent" @click="doDelete(w.name)">🗑️ 删除</button>
              <span v-if="!isAdmin" class="tip">只读</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel" v-if="isAdmin">
      <h3>📤 网页上传自定义存档（本地文件）</h3>
      <div class="row">
        <input type="file" accept=".zip,.mcworld,.tar.gz,.tgz" @change="onFilePick" />
        <input v-model="fileWorldName" placeholder="世界名 (留空用文件名)" style="max-width:220px" />
        <button class="mini ok" :disabled="!file || uploading" @click="doUploadFile">{{ uploading ? '上传中...' : '上传并载入' }}</button>
      </div>
      <div v-if="uploading" class="progress">
        <div class="bar" :style="{ width: progress + '%' }"></div>
        <span>{{ progress }}% (分片 {{ doneChunks }}/{{ totalChunks }})</span>
      </div>
      <p class="tip">从手机/电脑选择 .zip / .mcworld / .tar.gz 存档直接上传，最大 500MB，自动分片上传。上传后自动解压为世界，可在列表中切换。</p>
    </div>

    <div class="panel" v-if="isAdmin">
      <h3>🌐 URL 上传存档</h3>
      <div class="row">
        <input v-model="url" placeholder="存档文件 URL (.zip / .mcworld / .tar.gz)" />
        <input v-model="name" placeholder="世界名 (留空自动命名)" style="max-width:200px" />
        <button class="mini ok" :disabled="!url" @click="doUpload">上传并载入</button>
      </div>
      <p class="tip">支持从任意可访问的 URL 下载 .zip/.mcworld/.tar.gz 存档；上传后自动解压为世界，可在列表中切换。</p>
    </div>

    <div class="panel" v-if="result">
      <h3>结果</h3>
      <pre class="result">{{ result }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getWorlds, switchWorld, deleteWorld, renameWorld, uploadWorld, uploadWorldFile, exportWorld, downloadExport, getRole } from '../api';

const worlds = ref([]);
const url = ref('');
const name = ref('');
const file = ref(null);
const fileWorldName = ref('');
const result = ref('');
const isAdmin = getRole() === 'admin';
const uploading = ref(false);
const progress = ref(0);
const doneChunks = ref(0);
const totalChunks = ref(0);

function fmtSize(b) {
  if (!b) return '—';
  if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
async function refresh() { try { worlds.value = (await getWorlds()).result || []; } catch (e) { result.value = `加载失败: ${e.message}`; } }
async function doExport(name) {
  if (!confirm(`确定导出世界「${name}」吗？将打包为 tar.gz 下载。`)) return;
  result.value = '正在导出世界 (打包+上传 R2，大世界需要一点时间)...';
  try {
    const r = await exportWorld(name);
    if (!r.ok) throw new Error(r.error || '导出失败');
    result.value = `导出完成 (${fmtSize(r.size)})，开始下载...`;
    const { blob, fileName } = await downloadExport(r.exportId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { result.value = `导出失败: ${e.message}`; }
}
async function doDelete(name) {
  // 危险操作双重确认: 先 confirm, 再要求输入世界名
  if (!confirm(`⚠️ 确定要永久删除世界「${name}」吗？\n\n此操作不可恢复！`)) return;
  const typed = prompt(`永久删除「${name}」\n\n请输入世界名确认删除:`, '');
  if (!typed || typed !== name) { result.value = '已取消删除 (输入的世界名不匹配)'; return; }
  uploading.value = true;
  try {
    result.value = JSON.stringify(await deleteWorld(name));
    await refresh();
    result.value = `✅ 世界「${name}」已删除`;
  } catch (e) { result.value = `删除失败: ${e.message}`; }
  uploading.value = false;
}
async function doSwitch(name) {
  if (!confirm(`确定切换到世界「${name}」吗？服务器将自动重启。`)) return;
  try { result.value = JSON.stringify(await switchWorld(name)); } catch (e) { result.value = `错误: ${e.message}`; }
  refresh();
}
async function doRename(name) {
  const newName = prompt(`重命名世界「${name}」为新名称:`, name);
  if (!newName || newName.trim() === name) return;
  if (!confirm(`确定将世界「${name}」重命名为「${newName.trim()}」？\n\n若为当前世界，服务器会自动重启。`)) return;
  try {
    const r = await renameWorld(name, newName.trim());
    result.value = (r.ok === false ? `重命名失败: ${r.error || '未知错误'}` : `✅ 已重命名为「${r.renamed}」${r.restarted ? '（当前世界已重启）' : ''}`);
  } catch (e) { result.value = `错误: ${e.message}`; }
  refresh();
}
function goPacks(name) {
  // 目标世界名存 sessionStorage, 供 Packs 页默认选中
  try { sessionStorage.setItem('mc1life_packs_world', name); } catch {}
  location.href = '/packs';
}
async function doUpload() {
  try { result.value = JSON.stringify(await uploadWorld(url.value, name.value)); url.value = ''; name.value = ''; } catch (e) { result.value = `错误: ${e.message}`; }
  refresh();
}
function onFilePick(e) {
  file.value = e.target.files?.[0] || null;
  if (file.value && !fileWorldName.value) {
    fileWorldName.value = file.value.name.replace(/\.(zip|mcworld|tar\.gz|tgz)$/i, '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  }
}
async function doUploadFile() {
  if (!file.value) return;
  uploading.value = true; progress.value = 0; doneChunks.value = 0; totalChunks.value = 0;
  result.value = '正在上传存档 (自动分片, 断片自动重试)...';
  try {
    const r = await uploadWorldFile(file.value, fileWorldName.value || '', (p, done, total) => {
      progress.value = p; doneChunks.value = done; totalChunks.value = total;
      if (total && done !== total && p < 95) result.value = `正在上传分片 ${done}/${total}...`;
    });
    result.value = (r.ok === false ? `导入失败: ${r.error || '未知错误'}` : `✅ 上传完成, 已提交后台导入 (${r.message || ''})`);
    file.value = null;
    fileWorldName.value = '';
    const inp = document.querySelector('input[type=file]');
    if (inp) inp.value = '';
    // 轮询世界列表: 导入需要 1-2 分钟, 每 3s 刷一次直到新世界出现 (最多 60s)
    const wantName = (r && r.worldName) || '';
    for (let i = 0; i < 20; i++) {
      await new Promise(res => setTimeout(res, 3000));
      try {
        const list = (await getWorlds()).result || [];
        if (wantName ? list.some(w => w.name === wantName || w.name.startsWith(wantName + '_')) : list.length > 0) {
          worlds.value = list;
          result.value = '✅ 新世界已出现在列表中, 可切换到该世界游玩';
          break;
        }
        if (i === 19) { worlds.value = list; result.value = '已上传, 世界列表仍在后台导入中, 请稍后手动刷新'; }
      } catch (e) { /* 网络抖动忽略, 继续轮询 */ }
    }
  } catch (e) { result.value = `错误: ${e.message}`; }
  uploading.value = false;
}
onMounted(refresh);
</script>

<style scoped>
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
.ops { display: flex; gap: 6px; }
.tag { padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #f3f4f6; color: #6b7280; }
.tag.cur { background: #dcfce7; color: #15803d; }
.mini { padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
.mini.ok { color: #15803d; border-color: #86efac; }
.mini.danger { color: #dc2626; border-color: #fca5a5; }
.mini:disabled { opacity: .4; cursor: not-allowed; }
.row { display: flex; gap: 8px; align-items: center; }
.row input[type=file] { flex: 1; padding: 6px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; background: #fff; }
.row input:not([type=file]) { flex: 1; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
.tip { color: #6b7280; font-size: 12.5px; margin-top: 8px; }
.progress { margin-top: 10px; background: #f3f4f6; border-radius: 8px; height: 22px; position: relative; overflow: hidden; }
.progress .bar { height: 100%; background: #2563eb; transition: width .3s; border-radius: 8px; }
.progress span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #1f2937; }
.result { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; font-size: 12.5px; white-space: pre-wrap; }
.empty { color: #9ca3af; padding: 14px; }
</style>
