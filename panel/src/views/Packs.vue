<template>
  <div class="page">
    <h2>🧩 行为包 / 材质包管理</h2>
    <div class="panel" v-if="worlds.length">
      <h3>选择世界</h3>
      <div class="row">
        <select v-model="world" @change="loadPacks">
          <option v-for="w in worlds" :key="w.name" :value="w.name">{{ w.name }}{{ w.isCurrent ? ' (当前)' : '' }}</option>
        </select>
        <button class="mini" @click="refresh">刷新列表</button>
        <span class="tip">{{ note }}</span>
      </div>
    </div>

    <div class="panel" v-if="!worlds.length && !loading">
      <h3>世界列表</h3>
      <div class="empty">暂无世界</div>
    </div>

    <!-- 材质包 -->
    <div class="panel" v-if="packs">
      <h3>🎨 材质包 (Resource Packs)</h3>
      <p class="tip">作用于当前世界的外观/音效/UI；需重启世界生效。</p>
      <div v-if="!packs.resource.length" class="empty">该世界暂无材质包</div>
      <table v-else>
        <thead><tr><th>名称</th><th>UUID</th><th>版本</th><th>大小</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="p in packs.resource" :key="p.uuid || p.folder">
            <td>{{ p.name }} <span v-if="!p.hasManifest" class="badge-warn">无 manifest</span></td>
            <td class="mono">{{ p.uuid || '—' }}</td>
            <td>{{ p.version }}</td>
            <td>{{ fmtSize(p.size) }}</td>
            <td><span class="tag" :class="p.enabled ? 'cur' : ''">{{ p.enabled ? '已启用' : '未启用' }}</span></td>
            <td class="ops">
              <button v-if="isAdmin" class="mini ok" :disabled="p.enabled" @click="doToggle(p, true)">启用</button>
              <button v-if="isAdmin" class="mini" :disabled="!p.enabled" @click="doToggle(p, false)">停用</button>
              <button v-if="isAdmin" class="mini danger" @click="doDelete(p)">删除</button>
              <span v-if="!isAdmin" class="tip">只读</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="isAdmin" class="upload-box">
        <h4>📤 上传材质包</h4>
        <div class="row">
          <input type="file" accept=".zip,.mcpack" :ref="el => rpInput = el" @change="onPick($event, 'resource')" />
          <span class="tip">.zip / .mcpack（内含 manifest.json 的资源包）</span>
        </div>
        <button class="mini ok" :disabled="!pendingFile" @click="doUpload('resource')">上传到当前世界</button>
      </div>
    </div>

    <!-- 行为包 -->
    <div class="panel" v-if="packs">
      <h3>⚙️ 行为包 (Behavior Packs)</h3>
      <p class="tip">修改当前世界的玩法/实体/脚本；需重启世界生效。</p>
      <div v-if="!packs.behavior.length" class="empty">该世界暂无行为包</div>
      <table v-else>
        <thead><tr><th>名称</th><th>UUID</th><th>版本</th><th>大小</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="p in packs.behavior" :key="p.uuid || p.folder">
            <td>{{ p.name }} <span v-if="!p.hasManifest" class="badge-warn">无 manifest</span></td>
            <td class="mono">{{ p.uuid || '—' }}</td>
            <td>{{ p.version }}</td>
            <td>{{ fmtSize(p.size) }}</td>
            <td><span class="tag" :class="p.enabled ? 'cur' : ''">{{ p.enabled ? '已启用' : '未启用' }}</span></td>
            <td class="ops">
              <button v-if="isAdmin" class="mini ok" :disabled="p.enabled" @click="doToggle(p, true)">启用</button>
              <button v-if="isAdmin" class="mini" :disabled="!p.enabled" @click="doToggle(p, false)">停用</button>
              <button v-if="isAdmin" class="mini danger" @click="doDelete(p)">删除</button>
              <span v-if="!isAdmin" class="tip">只读</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="isAdmin" class="upload-box">
        <h4>📤 上传行为包</h4>
        <div class="row">
          <input type="file" accept=".zip,.mcpack" :ref="el => bpInput = el" @change="onPick($event, 'behavior')" />
          <span class="tip">.zip / .mcpack（内含 manifest.json 的行为包）</span>
        </div>
        <button class="mini ok" :disabled="!pendingFile" @click="doUpload('behavior')">上传到当前世界</button>
      </div>
    </div>

    <div class="panel" v-if="result">
      <h3>结果</h3>
      <pre class="result">{{ result }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getWorlds, getWorldPacks, toggleWorldPack, deleteWorldPack, uploadPackFile, getRole, serverAction } from '../api';

const worlds = ref([]);
const world = ref('');
const packs = ref(null);
const loading = ref(true);
const note = ref('');
const result = ref('');
const isAdmin = getRole() === 'admin';
const pendingFile = ref(null);
const pendingType = ref('');
const rpInput = ref(null);
const bpInput = ref(null);

function fmtSize(b) {
  if (!b) return '—';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
async function refresh() {
  try { worlds.value = (await getWorlds()).result || []; } catch (e) { result.value = `加载失败: ${e.message}`; }
  // 优先使用 Worlds 页跳转时预选的世界
  let preset = '';
  try { preset = sessionStorage.getItem('mc1life_packs_world') || ''; sessionStorage.removeItem('mc1life_packs_world'); } catch {}
  if (preset && worlds.value.some(w => w.name === preset)) world.value = preset;
  if (!world.value && worlds.value.length) {
    const cur = worlds.value.find(w => w.isCurrent);
    world.value = cur ? cur.name : worlds.value[0].name;
  }
  if (world.value) await loadPacks();
  loading.value = false;
}
async function loadPacks() {
  if (!world.value) return;
  result.value = '';
  try { packs.value = await getWorldPacks(world.value); } catch (e) { result.value = `加载包列表失败: ${e.message}`; packs.value = null; }
}
async function doToggle(p, enabled) {
  if (!world.value) return;
  if (enabled && !confirm(`启用包「${p.name}」？重启该世界后生效。`)) return;
  if (!enabled && !confirm(`停用包「${p.name}」？重启该世界后生效。`)) return;
  try {
    result.value = JSON.stringify(await toggleWorldPack(world.value, p.uuid || p.folder, enabled));
    await loadPacks();
  } catch (e) { result.value = `操作失败: ${e.message}`; }
}
async function doDelete(p) {
  if (!world.value) return;
  if (!confirm(`⚠️ 确定从世界「${world.value}」永久删除包「${p.name}」？\n\n删除后需重新上传才能恢复！`)) return;
  try {
    result.value = JSON.stringify(await deleteWorldPack(world.value, p.uuid || p.folder));
    await loadPacks();
  } catch (e) { result.value = `删除失败: ${e.message}`; }
}
function onPick(e, type) {
  const f = e.target.files?.[0] || null;
  if (!f) return;
  pendingFile.value = f;
  pendingType.value = type;
}
async function doUpload(type) {
  if (!world.value || !pendingFile.value) return;
  const f = pendingFile.value;
  result.value = `正在上传${type === 'behavior' ? '行为包' : '材质包'} (${f.name})...`;
  try {
    const r = await uploadPackFile(world.value, type, f, (p) => { if (p < 100) result.value = `上传中 ${p}%...`; });
    result.value = (r.ok === false ? `上传失败: ${r.error || '未知错误'}` : `✅ 已提交安装: ${(r.message || '')} ${(r.pending ? '（后台处理中，稍后刷新查看）' : '')}`);
    if (type === 'behavior' && bpInput.value) bpInput.value.value = '';
    if (type === 'resource' && rpInput.value) rpInput.value.value = '';
    pendingFile.value = null;
    // 轮询刷新包列表 (后台解压+启用, 最多 40s)
    for (let i = 0; i < 13; i++) {
      await new Promise(res => setTimeout(res, 3000));
      try {
        await loadPacks();
        const cat = type === 'behavior' ? packs.value?.behavior : packs.value?.resource;
        if (cat && cat.some(p => p.name.includes(f.name.replace(/\.(zip|mcpack)$/i, '').slice(0, 20)))) {
          result.value = '✅ 包已安装并出现在列表中';
          return;
        }
      } catch (e) { /* 忽略抖动 */ }
    }
    result.value = '已提交上传，包列表仍在后台安装中，请稍后手动刷新';
  } catch (e) { result.value = `错误: ${e.message}`; }
}
onMounted(refresh);
</script>

<style scoped>
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f3f4f6; font-size: 13.5px; vertical-align: middle; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; color: #6b7280; }
.ops { display: flex; gap: 6px; }
.tag { padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #f3f4f6; color: #6b7280; }
.tag.cur { background: #dcfce7; color: #15803d; }
.badge-warn { background: #fef3c7; color: #b45309; border-radius: 4px; padding: 1px 6px; font-size: 11px; }
.mini { padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
.mini.ok { color: #15803d; border-color: #86efac; }
.mini.danger { color: #dc2626; border-color: #fca5a5; }
.mini:disabled { opacity: .4; cursor: not-allowed; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
select { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; background: #fff; min-width: 220px; }
.upload-box { margin-top: 16px; padding-top: 14px; border-top: 1px dashed #e5e7eb; }
.upload-box h4 { margin: 0 0 8px; font-size: 14px; }
.upload-box input[type=file] { padding: 6px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; background: #fff; }
.tip { color: #6b7280; font-size: 12.5px; }
.empty { color: #9ca3af; padding: 14px; font-size: 13.5px; }
.result { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; font-size: 12.5px; white-space: pre-wrap; }
h3 { margin-top: 0; }
</style>
