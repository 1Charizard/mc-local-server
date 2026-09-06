<template>
  <div class="page">
    <h2>🧩 行为包 / 材质包管理</h2>

    <!-- Tab 切换 -->
    <div class="tabs">
      <button :class="{ on: tab === 'world' }" @click="switchTab('world')">🌍 当前世界包</button>
      <button :class="{ on: tab === 'lib' }" @click="switchTab('lib')">📦 组件库</button>
    </div>

    <!-- ============ 世界包 ============ -->
    <template v-if="tab === 'world'">
      <div class="panel" v-if="worlds.length">
        <h3>选择世界</h3>
        <div class="row">
          <select v-model="world" @change="loadPacks">
            <option v-for="w in worlds" :key="w.name" :value="w.name">{{ w.name }}{{ w.isCurrent ? ' (当前)' : '' }}</option>
          </select>
          <button class="mini" @click="refresh">刷新列表</button>
          <button class="mini" @click="openLibUpload('resource')">➕ 从组件库添加材质包</button>
          <button class="mini" @click="openLibUpload('behavior')">➕ 从组件库添加行为包</button>
          <span class="tip">{{ note }}</span>
        </div>
      </div>

      <div class="panel" v-if="!worlds.length && !loading">
        <h3>世界列表</h3>
        <div class="empty">暂无世界</div>
      </div>

      <PackTable
        v-if="packs"
        title="🎨 材质包 (Resource Packs)"
        hint="作用于当前世界的外观/音效/UI；需重启世界生效。"
        :rows="packs.resource || []"
        :is-admin="isAdmin"
        @toggle="doToggle" @delete="doDelete"
      />
      <div class="panel" v-if="isAdmin">
        <h4>📤 上传材质包到当前世界</h4>
        <div class="row">
          <input type="file" accept=".zip,.mcpack" :ref="el => rpInput = el" @change="onPick($event, 'resource')" />
          <span class="tip">.zip / .mcpack（内含 manifest.json 的资源包）</span>
        </div>
        <button class="mini ok" :disabled="!pendingFile" @click="doUpload('resource')">上传到当前世界</button>
      </div>

      <PackTable
        v-if="packs"
        title="⚙️ 行为包 (Behavior Packs)"
        hint="修改当前世界的玩法/实体/脚本；需重启世界生效。"
        :rows="packs.behavior || []"
        :is-admin="isAdmin"
        @toggle="doToggle" @delete="doDelete"
      />
      <div class="panel" v-if="isAdmin">
        <h4>📤 上传行为包到当前世界</h4>
        <div class="row">
          <input type="file" accept=".zip,.mcpack" :ref="el => bpInput = el" @change="onPick($event, 'behavior')" />
          <span class="tip">.zip / .mcpack（内含 manifest.json 的行为包）</span>
        </div>
        <button class="mini ok" :disabled="!pendingFile" @click="doUpload('behavior')">上传到当前世界</button>
      </div>
    </template>

    <!-- ============ 组件库 ============ -->
    <template v-else>
      <div class="panel" v-if="isAdmin">
        <h3>📤 上传到组件库</h3>
        <div class="row">
          <input type="file" accept=".zip,.mcpack" :ref="el => libInput = el" @change="onLibPick($event)" />
          <select v-model="libType" style="min-width:120px">
            <option value="auto">自动识别</option>
            <option value="behavior">强制行为包</option>
            <option value="resource">强制材质包</option>
          </select>
          <button class="mini ok" :disabled="!libFile" @click="doLibUpload">上传到库</button>
        </div>
        <p class="tip">上传后所有世界都可在「当前世界包」里启用/停用该包，无需重复上传。</p>
      </div>

      <div class="panel" v-if="lib">
        <h3>🎨 组件库 · 材质包 <span class="cnt">{{ (lib.resource || []).length }} 个</span></h3>
        <div v-if="!(lib.resource || []).length" class="empty">组件库暂无材质包</div>
        <table v-else>
          <thead><tr><th>名称</th><th>UUID</th><th>版本</th><th>大小</th><th>被引用世界</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="p in lib.resource" :key="p.uuid">
              <td>{{ p.name }}</td>
              <td class="mono">{{ p.uuid || '—' }}</td>
              <td>{{ p.version }}</td>
              <td>{{ fmtSize(p.size) }}</td>
              <td>{{ p.refCount ? (p.refWorlds || []).join('、') : '—' }}</td>
              <td class="ops">
                <button v-if="isAdmin" class="mini ok" @click="addLibToWorld(p, 'resource')">添加到当前世界</button>
                <button v-if="isAdmin" class="mini danger" @click="doLibDelete(p)">删除</button>
                <span v-if="!isAdmin" class="tip">只读</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel" v-if="lib">
        <h3>⚙️ 组件库 · 行为包 <span class="cnt">{{ (lib.behavior || []).length }} 个</span></h3>
        <div v-if="!(lib.behavior || []).length" class="empty">组件库暂无行为包</div>
        <table v-else>
          <thead><tr><th>名称</th><th>UUID</th><th>版本</th><th>大小</th><th>被引用世界</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="p in lib.behavior" :key="p.uuid">
              <td>{{ p.name }}</td>
              <td class="mono">{{ p.uuid || '—' }}</td>
              <td>{{ p.version }}</td>
              <td>{{ fmtSize(p.size) }}</td>
              <td>{{ p.refCount ? (p.refWorlds || []).join('、') : '—' }}</td>
              <td class="ops">
                <button v-if="isAdmin" class="mini ok" @click="addLibToWorld(p, 'behavior')">添加到当前世界</button>
                <button v-if="isAdmin" class="mini danger" @click="doLibDelete(p)">删除</button>
                <span v-if="!isAdmin" class="tip">只读</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div class="panel" v-if="result">
      <h3>结果</h3>
      <pre class="result">{{ result }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, h } from 'vue';
import { getWorlds, getWorldPacks, toggleWorldPack, deleteWorldPack, uploadPackFile,
  getPackLibrary, deleteLibraryPack, uploadPackToLibrary, getRole } from '../api';

// ---- 通用包表格组件 (避免模板重复) ----
const PackTable = {
  props: ['title', 'hint', 'rows', 'isAdmin'],
  emits: ['toggle', 'delete'],
  setup(props, { emit }) {
    const fmtSize = (b) => {
      if (!b) return '—';
      if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
      return Math.round(b / 1024) + ' KB';
    };
    return () => h('div', { class: 'panel' }, [
      h('h3', props.title),
      props.hint ? h('p', { class: 'tip' }, props.hint) : null,
      !props.rows.length ? h('div', { class: 'empty' }, '该世界暂无' + (props.title.includes('材质') ? '材质包' : '行为包'))
        : h('table', null, [
          h('thead', null, [h('tr', null, ['名称', '来源', 'UUID', '版本', '大小', '状态', '操作'].map(x => h('th', x)))]),
          h('tbody', null, props.rows.map(p => h('tr', { key: p.uuid || p.folder }, [
            h('td', null, [p.name, p.hasManifest ? null : h('span', { class: 'badge-warn' }, ' 无 manifest')]),
            h('td', { class: 'tip' }, p.source === 'library' ? '📦 库' : '🌍 本世界'),
            h('td', { class: 'mono' }, p.uuid || '—'),
            h('td', null, p.version),
            h('td', null, fmtSize(p.size)),
            h('td', null, h('span', { class: 'tag ' + (p.enabled ? 'cur' : '') }, p.enabled ? '已启用' : '未启用')),
            h('td', { class: 'ops' }, [
              props.isAdmin ? h('button', { class: 'mini ok', disabled: p.enabled, onClick: () => emit('toggle', p, true) }, '启用') : null,
              props.isAdmin ? h('button', { class: 'mini', disabled: !p.enabled, onClick: () => emit('toggle', p, false) }, '停用') : null,
              props.isAdmin && p.source !== 'library' ? h('button', { class: 'mini danger', onClick: () => emit('delete', p) }, '删除') : null,
              props.isAdmin && p.source === 'library' ? h('span', { class: 'tip' }, '库包') : null,
              !props.isAdmin ? h('span', { class: 'tip' }, '只读') : null,
            ]),
          ]))),
        ]),
    ]);
  },
};

const worlds = ref([]);
const world = ref('');
const packs = ref(null);
const lib = ref(null);
const tab = ref('world');
const loading = ref(true);
const note = ref('');
const result = ref('');
const isAdmin = getRole() === 'admin';
const pendingFile = ref(null);
const pendingType = ref('');
const rpInput = ref(null);
const bpInput = ref(null);
const libInput = ref(null);
const libFile = ref(null);
const libType = ref('auto');

function fmtSize(b) {
  if (!b) return '—';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
function setWorldByName(n) { world.value = n; }
function switchTab(t) {
  tab.value = t;
  if (t === 'lib') loadLib();
}
async function refresh() {
  try { worlds.value = (await getWorlds()).result || []; } catch (e) { result.value = `加载失败: ${e.message}`; }
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
  try { packs.value = await getWorldPacks(world.value); }
  catch (e) { result.value = `加载包列表失败: ${e.message}`; packs.value = null; }
}
async function loadLib() {
  result.value = '';
  try { lib.value = await getPackLibrary(); }
  catch (e) { result.value = `加载组件库失败: ${e.message}`; lib.value = null; }
}
async function doToggle(p, enabled) {
  if (!world.value) return;
  if (!confirm(`${enabled ? '启用' : '停用'}包「${p.name}」？重启该世界后生效。`)) return;
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
// ---- 组件库 ----
function onLibPick(e) {
  libFile.value = e.target.files?.[0] || null;
}
async function doLibUpload() {
  if (!libFile.value) return;
  const f = libFile.value;
  result.value = `正在上传到组件库 (${f.name})...`;
  try {
    const r = await uploadPackToLibrary(libType.value, f, (p) => { if (p < 100) result.value = `上传中 ${p}%...`; });
    result.value = (r.ok === false ? `上传失败: ${r.error || '未知错误'}` : `✅ 已提交安装到组件库: ${(r.message || '')}（后台处理中，稍后刷新）`);
    if (libInput.value) libInput.value.value = '';
    libFile.value = null;
    // 轮询组件库刷新
    for (let i = 0; i < 13; i++) {
      await new Promise(res => setTimeout(res, 3000));
      try {
        await loadLib();
        const all = [...(lib.value?.behavior || []), ...(lib.value?.resource || [])];
        if (all.some(p => p.name.includes(f.name.replace(/\.(zip|mcpack)$/i, '').slice(0, 20)))) {
          result.value = '✅ 组件库已刷新，可到「当前世界包」勾选启用';
          return;
        }
      } catch (e) { /* ignore */ }
    }
    result.value = '已提交上传到组件库，仍在后台处理中，请稍后手动刷新';
  } catch (e) { result.value = `错误: ${e.message}`; }
}
async function doLibDelete(p) {
  if (!confirm(`⚠️ 确定从组件库永久删除「${p.name}」？\n\n将从组件库删除文件，并在所有引用它的世界中停用。`)) return;
  try {
    const r = await deleteLibraryPack(p.uuid);
    result.value = (r.ok === false ? `删除失败: ${r.error || '未知错误'}` : `✅ 已从组件库删除「${p.name}」`);
    await loadLib();
  } catch (e) { result.value = `删除失败: ${e.message}`; }
}
function openLibUpload(type) {
  if (!world.value) { result.value = '请先选择世界'; return; }
  const r = prompt(`从组件库添加${type === 'behavior' ? '行为包' : '材质包'}：请先在「组件库」页上传需要的包，然后在这里输入该包文件夹名（或名称关键词）`);
  if (!r) return;
  addLibByKeyword(type, r.trim());
}
async function addLibByKeyword(type, keyword) {
  // 通过加载库找到匹配包并启用
  try {
    const libData = await getPackLibrary();
    const rows = type === 'behavior' ? libData.behavior || [] : libData.resource || [];
    const found = rows.find(p => p.uuid === keyword || p.name === keyword || p.folder === keyword || p.name.includes(keyword));
    if (!found) { result.value = `组件库中未找到匹配的${type === 'behavior' ? '行为包' : '材质包'}「${keyword}」`; return; }
    await addLibToWorld(found, type);
  } catch (e) { result.value = `操作失败: ${e.message}`; }
}
async function addLibToWorld(p, type) {
  if (!world.value) { result.value = '请先在顶部选择世界'; return; }
  if (!confirm(`将包「${p.name}」添加到世界「${world.value}」并启用？重启后生效。`)) return;
  try {
    const r = await toggleWorldPack(world.value, p.uuid, true);
    result.value = JSON.stringify(r.result || r || {});
    await loadPacks();
  } catch (e) { result.value = `操作失败: ${e.message}`; }
}
onMounted(refresh);
</script>

<style scoped>
.tabs { display: flex; gap: 8px; margin-bottom: 4px; }
.tabs button { padding: 8px 18px; border: 1px solid #d1d5db; border-radius: 10px 10px 0 0; background: #f9fafb; font-size: 14px; cursor: pointer; }
.tabs button.on { background: #fff; font-weight: 600; border-bottom-color: #fff; }
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f3f4f6; font-size: 13.5px; vertical-align: middle; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; color: #6b7280; }
.ops { display: flex; gap: 6px; flex-wrap: wrap; }
.cnt { font-size: 12px; color: #6b7280; font-weight: normal; }
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
h3, h4 { margin-top: 0; }
</style>
