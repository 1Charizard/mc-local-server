<template>
  <div class="page">
    <h2>⚙️ 服务器设置</h2>

    <div class="panel hc" :class="{ on: hc && hc.enabled }">
      <h3>☠️ 极限生存模式</h3>
      <p class="tip">死亡即淘汰：检测到玩家死亡后自动执行删档（wipe）或封禁（ban）。删档前会自动备份世界到 R2，可在「备份回滚」页恢复。</p>
      <div class="hc-row">
        <div class="hc-field">
          <span class="label">当前状态</span>
          <span class="badge" :class="hc && hc.enabled ? 'on' : 'off'">{{ hc && hc.enabled ? '已开启' : '已关闭' }}</span>
          <span class="badge mode">{{ modeText }}</span>
        </div>
        <template v-if="isAdmin">
          <div class="hc-field">
            <span class="label">开关</span>
            <button class="mini" :class="hc && hc.enabled ? 'danger' : 'ok'" :disabled="busyHc" @click="toggleHardcore">
              {{ hc && hc.enabled ? '关闭极限模式' : '开启极限模式' }}
            </button>
          </div>
          <div class="hc-field">
            <span class="label">死亡处理方式</span>
            <select v-model="hcMode" :disabled="busyHc">
              <option value="wipe">wipe — 删档重开（删前自动备份）</option>
              <option value="ban">ban — 封禁该玩家</option>
            </select>
            <button class="mini ok" :disabled="busyHc || hcMode === (hc && hc.mode)" @click="saveMode">保存方式</button>
          </div>
        </template>
        <div v-else class="hc-field">
          <span class="label">权限</span>
          <span class="tip">访客模式只读，无法修改极限模式</span>
        </div>
      </div>
    </div>

    <div class="panel db" :class="{ on: db && db.enabled }">
      <h3>☠️ 玩家死亡自动备份</h3>
      <p class="tip">每次玩家死亡自动保存"死亡瞬间世界快照"（含该玩家背包/血量/Buff/坐标/末影箱/基地等全部个人数据），可在「备份回滚」页恢复。与极限生存模式互相独立，可单独开关。</p>
      <div class="hc-row">
        <div class="hc-field">
          <span class="label">当前状态</span>
          <span class="badge" :class="db && db.enabled ? 'on' : 'off'">{{ db && db.enabled ? '已开启' : '已关闭' }}</span>
          <span class="badge mode">每玩家保留 {{ (db && db.keepPerPlayer) || 3 }} 份</span>
        </div>
        <template v-if="isAdmin">
          <div class="hc-field">
            <span class="label">开关</span>
            <button class="mini" :class="db && db.enabled ? 'danger' : 'ok'" :disabled="busyDb" @click="toggleDb">
              {{ db && db.enabled ? '关闭死亡自动备份' : '开启死亡自动备份' }}
            </button>
          </div>
          <div class="hc-field">
            <span class="label">每玩家保留份数</span>
            <div class="row-tight">
              <input type="number" v-model.number="dbKeep" min="1" max="20" style="width:70px" />
              <button class="mini ok" :disabled="busyDb || dbKeep === (db && db.keepPerPlayer)" @click="saveDbKeep">保存</button>
            </div>
          </div>
        </template>
        <div v-else class="hc-field">
          <span class="label">权限</span>
          <span class="tip">访客模式只读，无法修改</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>配置文件</h3>
      <div class="tabs">
        <button v-for="f in files" :key="f.file" class="tab" :class="{ active: f.file === currentFile }" @click="loadFile(f.file)">
          {{ f.file }}
        </button>
      </div>
    </div>
    <div class="panel" v-if="currentFile">
      <h3>编辑 {{ currentFile }} <button class="mini ok" :disabled="busy" @click="save">保存修改</button></h3>
      <!-- properties 键值编辑 -->
      <table v-if="configType === 'properties'">
        <thead><tr><th>配置项</th><th>值</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="(v, k) in props" :key="k">
            <td><code>{{ k }}</code></td>
            <td><input v-model="props[k]" /></td>
            <td><button class="mini danger" @click="removeProp(k)">移除</button></td>
          </tr>
          <tr>
            <td><input v-model="newKey" placeholder="新配置项" /></td>
            <td><input v-model="newVal" placeholder="值" /></td>
            <td><button class="mini ok" @click="addProp">添加</button></td>
          </tr>
        </tbody>
      </table>
      <!-- JSON 文件文本编辑 -->
      <textarea v-else v-model="jsonText" class="json-area" rows="14"></textarea>
    </div>
    <div class="panel" v-if="result">
      <h3>结果</h3>
      <pre class="result">{{ result }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { getConfig, getConfigFiles, setConfig, getHardcore, setHardcore, getDeathBackup, setDeathBackup, getRole } from '../api';

const files = ref([]);
const currentFile = ref('server.properties');
const configType = ref('properties');
const props = ref({});
const jsonText = ref('');
const newKey = ref('');
const newVal = ref('');
const result = ref('');
const busy = ref(false);
const busyHc = ref(false);
const busyDb = ref(false);
const isAdmin = getRole() === 'admin';

// 极限生存模式
const hc = ref(null);
const hcMode = ref('wipe');
const modeText = computed(() => (hc.value?.mode === 'ban' ? '模式: 封禁玩家' : '模式: 删档重开'));

// 死亡自动备份 (独立开关)
const db = ref(null);
const dbKeep = ref(3);
async function loadDeathBackup() {
  try {
    const r = await getDeathBackup();
    db.value = r.deathBackup || r || { enabled: true, keepPerPlayer: 3 };
    dbKeep.value = db.value?.keepPerPlayer || 3;
  } catch { db.value = { enabled: true, keepPerPlayer: 3 }; }
}
async function toggleDb() {
  busyDb.value = true;
  try {
    const next = !(db.value?.enabled);
    const r = await setDeathBackup(next, db.value?.keepPerPlayer);
    db.value = r.deathBackup || { enabled: next, keepPerPlayer: db.value?.keepPerPlayer };
    result.value = `死亡自动备份已${next ? '开启' : '关闭'}`;
  } catch (e) { result.value = `操作失败: ${e.message}`; }
  busyDb.value = false;
}
async function saveDbKeep() {
  busyDb.value = true;
  try {
    const k = Math.max(1, Math.min(20, Number(dbKeep.value) || 3));
    const r = await setDeathBackup(db.value?.enabled, k);
    db.value = r.deathBackup || { enabled: db.value?.enabled, keepPerPlayer: k };
    dbKeep.value = k;
    result.value = `每玩家保留份数已设为 ${k}`;
  } catch (e) { result.value = `操作失败: ${e.message}`; }
  busyDb.value = false;
}

async function loadHardcore() {
  try {
    const r = await getHardcore();
    hc.value = r.hardcore || r;
    hcMode.value = hc.value?.mode || 'wipe';
  } catch { hc.value = null; }
}
async function toggleHardcore() {
  busyHc.value = true;
  try {
    const next = !(hc.value?.enabled);
    const r = await setHardcore(next, null);
    hc.value = r.hardcore || { enabled: next, mode: hc.value?.mode };
    hcMode.value = hc.value.mode || 'wipe';
    result.value = `极限模式已${next ? '开启' : '关闭'}`;
  } catch (e) { result.value = `操作失败: ${e.message}`; }
  busyHc.value = false;
}
async function saveMode() {
  busyHc.value = true;
  try {
    const r = await setHardcore(null, hcMode.value);
    hc.value = r.hardcore || { enabled: hc.value?.enabled, mode: hcMode.value };
    result.value = `极限模式处理方式已改为: ${hc.value.mode === 'ban' ? '封禁玩家' : '删档重开'}`;
  } catch (e) { result.value = `操作失败: ${e.message}`; }
  busyHc.value = false;
}

async function refreshFiles() { try { files.value = (await getConfigFiles()).result || []; } catch {} }
async function loadFile(file) {
  currentFile.value = file;
  try {
    const r = await getConfig(file);
    configType.value = r.type;
    if (r.type === 'properties') props.value = { ...r.data };
    else jsonText.value = JSON.stringify(r.data, null, 2);
  } catch (e) { result.value = `加载失败: ${e.message}`; }
}
function removeProp(k) { delete props.value[k]; }
function addProp() { if (newKey.value) { props.value[newKey.value] = newVal.value; newKey.value = ''; newVal.value = ''; } }
async function save() {
  busy.value = true;
  try {
    if (configType.value === 'properties') {
      const restart = confirm('server.properties 修改需要重启生效，是否立即重启服务器？');
      let saved = 0;
      for (const [k, v] of Object.entries(props.value)) {
        await setConfig(currentFile.value, k, v, false);
        saved++;
      }
      result.value = `已保存 ${saved} 项配置` + (restart ? '，正在重启服务器...' : '');
      if (restart) await setConfig(currentFile.value, 'max-players', props.value['max-players'], true);
    } else {
      result.value = 'JSON 文件请使用控制台指令或 Agent 文件接口修改 (此版本提供只读预览)';
    }
  } catch (e) { result.value = `保存失败: ${e.message}`; }
  busy.value = false;
}
onMounted(async () => { await loadHardcore(); await loadDeathBackup(); await refreshFiles(); loadFile('server.properties'); });
</script>

<style scoped>
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.panel.hc { border-left: 4px solid #6b7280; }
.panel.hc.on { border-left-color: #dc2626; }
.panel.db { border-left: 4px solid #6b7280; }
.panel.db.on { border-left-color: #b45309; }
.panel h3 { font-size: 15px; margin-bottom: 10px; }
.tip { color: #6b7280; font-size: 12.5px; margin-bottom: 12px; }
.hc-row { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
.hc-field { display: flex; flex-direction: column; gap: 8px; }
.hc-field .label { font-size: 12px; color: #6b7280; }
.badge { display: inline-block; padding: 3px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; width: fit-content; }
.badge.on { background: #fee2e2; color: #b91c1c; }
.badge.off { background: #f3f4f6; color: #6b7280; }
.badge.mode { background: #eef2ff; color: #4338ca; }
.row-tight { display: flex; gap: 6px; align-items: center; }
.row-tight input { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; }
select { padding: 7px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 13px; background: #fff; }
.tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.tab { padding: 6px 14px; border: 1px solid #d1d5db; border-radius: 999px; background: #fff; font-size: 12.5px; cursor: pointer; }
.tab.active { background: #2563eb; color: #fff; border-color: #2563eb; }
table { width: 100%; border-collapse: collapse; margin-top: 10px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f3f4f6; font-size: 13.5px; }
td input { width: 100%; padding: 5px 8px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; }
.json-area { width: 100%; font-family: ui-monospace, monospace; font-size: 12.5px; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; margin-top: 10px; }
.mini { padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
.mini.ok { color: #15803d; border-color: #86efac; }
.mini.danger { color: #b91c1c; border-color: #fca5a5; }
.mini:disabled { opacity: .5; cursor: not-allowed; }
.result { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; font-size: 12.5px; white-space: pre-wrap; }
</style>
