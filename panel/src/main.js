import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Dashboard from './views/Dashboard.vue';
import ConsoleView from './views/ConsoleView.vue';
import Players from './views/Players.vue';
import Worlds from './views/Worlds.vue';
import Packs from './views/Packs.vue';
import Backups from './views/Backups.vue';
import Settings from './views/Settings.vue';
import Login from './views/Login.vue';
import { getAuthToken } from './api';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: Login },
    { path: '/', component: Dashboard, meta: { title: '仪表盘' } },
    { path: '/console', component: ConsoleView, meta: { title: '控制台' } },
    { path: '/players', component: Players, meta: { title: '玩家管理' } },
    { path: '/worlds', component: Worlds, meta: { title: '存档管理' } },
    { path: '/packs', component: Packs, meta: { title: '包管理' } },
    { path: '/backups', component: Backups, meta: { title: '备份回滚' } },
    { path: '/settings', component: Settings, meta: { title: '服务器设置' } },
  ],
});

// 路由守卫: 未登录跳转登录页
router.beforeEach((to) => {
  if (to.path !== '/login' && !getAuthToken()) return '/login';
  return true;
});

createApp(App).use(router).mount('#app');
