<template>
  <div class="app" v-if="!isLogin">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo">⛏️</div>
        <div>
          <h1>MC1life</h1>
          <p>基岩版服务器管理</p>
        </div>
      </div>
      <div class="role-badge" :class="roleClass">{{ roleText }}</div>
      <nav>
        <RouterLink v-for="r in routes" :key="r.path" :to="r.path" class="nav-item">
          {{ r.meta.title }}
        </RouterLink>
      </nav>
      <div class="side-status" :class="statusClass">
        <span class="dot"></span>{{ statusText }}
      </div>
      <button class="logout" @click="logout">退出登录</button>
    </aside>
    <main class="content">
      <RouterView />
    </main>
  </div>
  <RouterView v-else />
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getStatus, clearAuthToken, getRole } from './api';

const route = useRoute();
const router = useRouter();
const isLogin = computed(() => route.path === '/login');

const routes = [
  { path: '/', meta: { title: '📊 仪表盘' } },
  { path: '/console', meta: { title: '💻 控制台' } },
  { path: '/players', meta: { title: '👥 玩家管理' } },
  { path: '/worlds', meta: { title: '🗺️ 存档管理' } },
  { path: '/packs', meta: { title: '🧩 包管理' } },
  { path: '/backups', meta: { title: '💾 备份回滚' } },
  { path: '/settings', meta: { title: '⚙️ 服务器设置' } },
];

const role = getRole();
const roleClass = role === 'admin' ? 'admin' : 'viewer';
const roleText = role === 'admin' ? '🔑 管理员 · 全权' : '👁 访客 · 只读';

const status = ref(null);
let timer = null;

async function refresh() {
  try { status.value = await getStatus(); } catch (e) { status.value = null; }
}

const statusClass = computed(() => (status.value?.running ? 'ok' : 'down'));
const statusText = computed(() => {
  if (status.value?.agent === 'offline') return '● Agent 未连接';
  return status.value?.running ? '● 服务器运行中' : '● 服务器离线';
});

function logout() {
  clearAuthToken();
  router.push('/login');
}

onMounted(() => { if (!isLogin.value) { refresh(); timer = setInterval(refresh, 10000); } });
onUnmounted(() => clearInterval(timer));
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #f0f2f5; color: #1f2937; }
.app { display: flex; min-height: 100vh; }
.sidebar { width: 230px; background: #111827; color: #e5e7eb; padding: 20px 0; display: flex; flex-direction: column; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; gap: 10px; align-items: center; padding: 0 20px 20px; border-bottom: 1px solid #1f2937; }
.logo { font-size: 32px; }
.brand h1 { font-size: 20px; color: #fff; }
.brand p { font-size: 12px; color: #9ca3af; }
.role-badge { margin: 10px 14px 0; padding: 7px 12px; border-radius: 8px; font-size: 12.5px; font-weight: 600; text-align: center; }
.role-badge.admin { background: #1e3a5f; color: #7dd3fc; border: 1px solid #1d4ed8; }
.role-badge.viewer { background: #374151; color: #d1d5db; border: 1px solid #4b5563; }
nav { flex: 1; padding: 14px 10px; display: flex; flex-direction: column; gap: 4px; }
.nav-item { display: block; padding: 10px 14px; border-radius: 8px; color: #d1d5db; text-decoration: none; font-size: 14px; }
.nav-item:hover, .nav-item.router-link-active { background: #1f2937; color: #fff; }
.side-status { padding: 12px 20px; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.side-status .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
.side-status.ok .dot { background: #22c55e; }
.side-status.ok { color: #4ade80; }
.side-status.down { color: #f87171; }
.logout { margin: 0 14px 8px; padding: 9px; border: none; border-radius: 8px; background: #1f2937; color: #e5e7eb; font-size: 13px; cursor: pointer; }
.logout:hover { background: #374151; }
.content { flex: 1; padding: 24px; max-width: 1200px; }
</style>
