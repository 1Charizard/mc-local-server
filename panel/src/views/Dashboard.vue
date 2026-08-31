<template>
  <div class="page">
    <h2>📊 仪表盘</h2>
    <div v-if="!status" class="empty">正在连接 Agent ...</div>
    <div v-else-if="status.agent === 'offline'" class="panel offline">
      <h3>📡 服务器离线</h3>
      <p class="tip">Agent 未连接（手机端未运行或网络不通）。面板仍可正常访问，恢复后数据将自动刷新。</p>
      <p class="tip">手机端启动：<code>proot-distro login debian-trixie-aarch64 -- bash /opt/mc1life/start_agent.sh</code></p>
    </div>
    <div v-else>
      <div class="cards">
        <div class="card" :class="status.running ? 'green' : 'red'">
          <div class="label">服务器状态</div>
          <div class="value">{{ status.running ? '运行中' : '离线' }}</div>
        </div>
        <div class="card">
          <div class="label">在线玩家</div>
          <div class="value">{{ (status.players || []).length }} <span class="sub">/ {{ status.maxPlayers || '?' }}</span></div>
        </div>
        <div class="card">
          <div class="label">内存 (RSS)</div>
          <div class="value">{{ status.mem?.rss || 0 }} <span class="sub">MB</span></div>
        </div>
        <div class="card">
          <div class="label">CPU</div>
          <div class="value">{{ status.cpu || 0 }}<span class="sub">%</span></div>
        </div>
        <div class="card">
          <div class="label">运行时长</div>
          <div class="value">{{ fmtUptime(status.uptime) }}</div>
        </div>
        <div class="card">
          <div class="label">服务器版本</div>
          <div class="value small">{{ status.version || '未知' }}</div>
        </div>
      </div>

      <div class="panel">
        <h3>在线玩家</h3>
        <div v-if="!status.players?.length" class="empty">暂无玩家在线</div>
        <div v-else class="player-chips">
          <span v-for="p in status.players" :key="p" class="chip">{{ p }}</span>
        </div>
      </div>

      <div class="panel" v-if="isAdmin">
        <h3>服务器控制</h3>
        <div class="actions">
          <button class="btn ok" :disabled="status.running" @click="act('start')">▶ 启动</button>
          <button class="btn warn" :disabled="!status.running" @click="act('stop')">⏹ 停止</button>
          <button class="btn danger" :disabled="!status.running" @click="act('restart')">🔄 重启</button>
        </div>
      </div>
      <div class="panel" v-else>
        <h3>服务器控制</h3>
        <p class="tip">当前为访客模式（只读），无法操作服务器。</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { getStatus, serverAction, getRole } from '../api';

const status = ref(null);
const isAdmin = getRole() === 'admin';
let timer = null;

async function refresh() { try { status.value = await getStatus(); } catch { status.value = null; } }
async function act(a) {
  if (a === 'stop' && !confirm('确定要停止服务器吗？在线玩家会被强制下线。')) return;
  if (a === 'restart' && !confirm('确定要重启服务器吗？')) return;
  await serverAction(a);
  setTimeout(refresh, 1500);
}
function fmtUptime(s) {
  if (!s) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}天${h}时` : h ? `${h}时${m}分` : `${m}分`;
}

onMounted(() => { refresh(); timer = setInterval(refresh, 8000); });
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; margin: 16px 0; }
.card { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); border-left: 4px solid #6366f1; }
.card.green { border-left-color: #22c55e; }
.card.red { border-left-color: #ef4444; }
.card .label { font-size: 12px; color: #6b7280; }
.card .value { font-size: 24px; font-weight: 700; margin-top: 6px; }
.card .value.small { font-size: 14px; }
.card .sub { font-size: 13px; color: #9ca3af; font-weight: 400; }
.panel { background: #fff; border-radius: 12px; padding: 18px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.panel h3 { font-size: 15px; margin-bottom: 12px; }
.panel.offline { border-left: 4px solid #f59e0b; }
.tip { color: #6b7280; font-size: 13px; }
.tip code { background: #e5e7eb; border-radius: 4px; padding: 1px 6px; }
.player-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { background: #eef2ff; color: #4338ca; padding: 5px 12px; border-radius: 999px; font-size: 13px; }
.actions { display: flex; gap: 10px; }
.btn { padding: 9px 18px; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; color: #fff; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn.ok { background: #22c55e; } .btn.warn { background: #f59e0b; } .btn.danger { background: #ef4444; }
.empty { color: #9ca3af; padding: 20px; text-align: center; }
</style>
