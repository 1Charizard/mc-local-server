<template>
  <div class="page">
    <h2>🧩 包管理 <span class="cnt">Java 服务端模式 (互通)</span></h2>

    <!-- 引擎语义提示 -->
    <div class="panel warn">
      <b>互通规则：</b>行为包 = <b>Java 数据包</b>（放服务端 datapacks/，Java/基岩玩家双端生效）；
      材质包<b>双平台独立</b>（Java 版→电脑玩家；基岩版→Geyser 推送给手机玩家，互不影响联机）。
      基岩行为包(addon)与 Java 不互通，已禁用。
    </div>

    <!-- Tab -->
    <div class="tabs">
      <button :class="{ on: tab === 'datapack' }" @click="tab='datapack'; loadAll()">⚙️ 数据包 (行为, 双端)</button>
      <button :class="{ on: tab === 'res' }" @click="tab='res'; loadAll()">🎨 材质包 (双平台)</button>
    </div>

    <!-- ============ 数据包 (行为包 = Java datapack) ============ -->
    <template v-if="tab === 'datapack'">
      <div class="panel">
        <div class="row">
          <label>世界：</label>
          <select v-model="world" @change="loadPacks">
            <option v-for="w in worlds" :key="w.name" :value="w.name">{{ w.name }}{{ w.isCurrent ? ' (当前)' : '' }}</option>
          </select>
          <button class="mini" @click="refresh">刷新</button>
          <span class="tip">{{ note }}</span>
        </div>
        <p class="tip">数据包放入该世界 datapacks/ 即生效（双端互通）；删除数据包目录即停用。</p>
      </div>

      <div class="panel" v-if="packs">
        <h3>📦 {{ world }} · 数据包 <span class="cnt">{{ (packs.datapacks || []).length }} 个</span></h3>
        <div v-if="!(packs.datapacks || []).length" class="empty">该世界暂无数据包</div>
        <table v-else>
          <thead><tr><th>名称</th><th>描述</th><th>大小</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="p in packs.datapacks" :key="p.uuid">
              <td>{{ p.name }}</td>
              <td class="tip">{{ p.description || '—' }}</td>
              <td>{{ fmtSize(p.size) }}</td>
              <td><span class="tag cur">互通生效</span></td>
              <td class="ops">
                <button v-if="isAdmin" class="mini danger" @click="doDeleteDatapack(p)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel" v-if="isAdmin && world">
        <h4>📤 上传数据包到「{{ world }}」</h4>
        <div class="row">
          <input type="file" accept=".zip" :ref="el => dpInput = el" @change="onPick($event, 'datapack')" />
          <span class="tip">.zip 内含 pack.mcmeta + data/（Java 数据包，双端互通）。基岩 .mcpack addon 不受支持。</span>
        </div>
        <button class="mini ok" :disabled="!pendingFile" @click="doUpload('datapack')">上传到当前世界</button>
      </div>
    </template>

    <!-- ============ 材质包 (双平台) ============ -->
    <template v-else>
      <div class="panel">
        <div class="row">
          <label>世界：</label>
          <select v-model="world" @change="loadPacks">
            <option v-for="w in worlds" :key="w.name" :value="w.name">{{ w.name }}{{ w.isCurrent ? ' (当前)' : '' }}</option>
          </select>
          <button class="mini" @click="refresh">刷新</button>
          <span class="tip">{{ note }}</span>
        </div>
      </div>

      <div class="panel" v-if="packs">
        <h3>💻 Java 版材质包 <span class="cnt">{{ (packs.resources?.java || []).length }} 个 · 仅 Java 电脑玩家 · 同刻启用 1 个 · 重启生效</span></h3>
        <div v-if="!(packs.resources?.java || []).length" class="empty">暂无 Java 版材质包</div>
        <table v-else>
          <thead><tr><th>名称</th><th>大小</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="p in packs.resources.java" :key="p.uuid">
              <td>{{ p.name }}</td>
              <td>{{ fmtSize(p.size) }}</td>
              <td><span class="tag" :class="p.enabled ? 'cur' : ''">{{ p.enabled ? '已启用' : '未启用' }}</span></td>
              <td class="ops">
                <button v-if="isAdmin" class="mini ok" :disabled="p.enabled" @click="doToggleRes(p, true)">启用</button>
                <button v-if="isAdmin" class="mini" :disabled="!p.enabled" @click="doToggleRes(p, false)">停用</button>
                <button v-if="isAdmin" class="mini danger" @click="doDeleteRes(p, 'java')">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="isAdmin" class="upload-box">
          <h4>📤 上传 Java 版材质包</h4>
          <div class="row">
            <input type="file" accept=".zip" :ref="el => rjInput = el" @change="onPick($event, 'resource-java')" />
            <span class="tip">.zip 内含 pack.mcmeta + assets/（Java 资源包）。上传后需「启用」并重启才发给 Java 玩家。</span>
          </div>
          <button class="mini ok" :disabled="!pendingFile" @click="doUpload('resource-java')">上传到库</button>
        </div>
      </div>

      <div class="panel" v-if="packs">
        <h3>📱 基岩版材质包 <span class="cnt">{{ (packs.resources?.bedrock || []).length }} 个 · 仅基岩手机玩家 · Geyser 推送 · 重启生效</span></h3>
        <div v-if="!(packs.resources?.bedrock || []).length" class="empty">暂无基岩版材质包</div>
        <table v-else>
          <thead><tr><th>名称</th><th>大小</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="p in packs.resources.bedrock" :key="p.uuid">
              <td>{{ p.name }}</td>
              <td>{{ fmtSize(p.size) }}</td>
              <td><span class="tag" :class="p.enabled ? 'cur' : ''">{{ p.enabled ? '已启用' : '未启用' }}</span></td>
              <td class="ops">
                <button v-if="isAdmin" class="mini ok" :disabled="p.enabled" @click="doToggleRes(p, true)">启用</button>
                <button v-if="isAdmin" class="mini" :disabled="!p.enabled" @click="doToggleRes(p, false)">停用</button>
                <button v-if="isAdmin" class="mini danger" @click="doDeleteRes(p, 'bedrock')">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="isAdmin" class="upload-box">
          <h4>📤 上传基岩版材质包</h4>
          <div class="row">
            <input type="file" accept=".zip,.mcpack" :ref="el => rbInput = el" @change="onPick($event, 'resource-bedrock')" />
            <span class="tip">.mcpack / .zip 内含 manifest.json（基岩材质包，resources 模块）。基岩行为 addon 会被拒绝。</span>
          </div>
          <button class="mini ok" :disabled="!pendingFile" @click="doUpload('resource-bedrock')">上传到库</button>
        </div>
      </div>
    </template>

    <div class="panel" v-if="result">
      <h3>结果</h3>
      <pre class="result">{{ result }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getWorlds, getWorldPacks, toggleWorldPack, deleteWorldPack, uploadPackFile, deleteLibraryPack, getRole } from '../api';

const worlds = ref([]);
const world = ref('');
const packs = ref(null);
const tab = ref('datapack');
const loading = ref(true);
const note = ref('');
const result = ref('');
const isAdmin = getRole() === 'admin';
const pendingFile = ref(null);
const dpInput = ref(null);
const rjInput = ref(null);
const rbInput = ref(null);

function fmtSize(b) {
  if (!b) return '—';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
async function refresh() {
  try { worlds.value = (await getWorlds()).result || []; } catch (e) { result.value = `加载失败: ${e.message}`; }
  if (!world.value && worlds.value.length) {
    const cur = worlds.value.find(w => w.isCurrent);
    world.value = cur ? cur.name : worlds.value[0].name;
  }
  if (world.value) await loadPacks();
  loading.value = false;
}
async function loadAll() {
  if (world.value) await loadPacks();
}
async function loadPacks() {
  if (!world.value) return;
  result.value = '';
  try { packs.value = await getWorldPacks(world.value); }
  catch (e) { result.value = `加载包列表失败: ${e.message}`; packs.value = null; }
}
function onPick(e) {
  pendingFile.value = e.target.files?.[0] || null;
}
function clearFile() {
  if (dpInput.value) dpInput.value.value = '';
  if (rjInput.value) rjInput.value.value = '';
  if (rbInput.value) rbInput.value.value = '';
  pendingFile.value = null;
}
async function doUpload(type) {
  if (!world.value || !pendingFile.value) return;
  const f = pendingFile.value;
  const label = type === 'datapack' ? '数据包' : type === 'resource-java' ? 'Java 材质包' : '基岩材质包';
  result.value = `正在上传${label} (${f.name})...`;
  try {
    const r = await uploadPackFile(world.value, type, f, (p) => { if (p < 100) result.value = `上传中 ${p}%...`; });
    result.value = (r.ok === false ? `上传失败: ${r.error || '未知错误'}` : `✅ 已提交安装: ${(r.message || '')} ${r.pending ? '（后台处理中，稍后自动刷新）' : ''}`);
    clearFile();
    for (let i = 0; i < 15; i++) {
      await new Promise(res => setTimeout(res, 3000));
      try {
        await loadPacks();
        const cat = type === 'datapack' ? packs.value?.datapacks
          : type === 'resource-java' ? packs.value?.resources?.java : packs.value?.resources?.bedrock;
        if (cat && cat.some(p => (p.name || '').includes(f.name.replace(/\.(zip|mcpack)$/i, '').slice(0, 15)))) {
          result.value = '✅ 已上传并出现在列表中';
          return;
        }
      } catch (e) { /* 忽略抖动 */ }
    }
    result.value = '已提交上传，仍在后台处理，请稍后手动刷新';
  } catch (e) { result.value = `错误: ${e.message}`; }
}
async function doToggleRes(p, enabled) {
  const label = p.platform === 'java' ? 'Java 材质包' : '基岩材质包';
  if (!confirm(`${enabled ? '启用' : '停用'}${label}「${p.name}」？需重启服务端后对玩家生效。`)) return;
  try {
    result.value = JSON.stringify(await toggleWorldPack(world.value, p.uuid || p.folder, enabled));
    await loadPacks();
  } catch (e) { result.value = `操作失败: ${e.message}`; }
}
async function doDeleteDatapack(p) {
  if (!confirm(`⚠️ 确定从世界「${world.value}」永久删除数据包「${p.name}」？`)) return;
  try {
    result.value = JSON.stringify(await deleteWorldPack(world.value, p.uuid || p.folder));
    await loadPacks();
  } catch (e) { result.value = `删除失败: ${e.message}`; }
}
async function doDeleteRes(p, platform) {
  const label = platform === 'java' ? 'Java 材质包' : '基岩材质包';
  if (!confirm(`⚠️ 确定永久删除${label}「${p.name}」？若已启用会同时停用。`)) return;
  try {
    result.value = JSON.stringify(await deleteLibraryPack(p.uuid || p.folder));
    await loadPacks();
  } catch (e) { result.value = `删除失败: ${e.message}`; }
}
onMounted(refresh);
</script>

<style scoped>
.tabs { display: flex; gap: 8px; margin-bottom: 4px; }
.tabs button { padding: 8px 18px; border: 1px solid #d1d5db; border-radius: 10px 10px 0 0; background: #f9fafb; font-size: 14px; cursor: pointer; }
.tabs button.on { background: #fff; font-weight: 600; border-bottom-color: #fff; }
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.panel.warn { background: #fffbeb; border: 1px solid #fde68a; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f3f4f6; font-size: 13.5px; vertical-align: middle; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; color: #6b7280; }
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
.cnt { font-size: 12px; color: #6b7280; font-weight: normal; }
.tag { padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #f3f4f6; color: #6b7280; }
.tag.cur { background: #dcfce7; color: #15803d; }
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
h3, h4 { margin-top: 0; }
label { font-weight: 600; font-size: 13px; }
</style>
