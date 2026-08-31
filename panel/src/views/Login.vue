<template>
  <div class="login-wrap">
    <div class="login-box">
      <div class="logo">⛏️</div>
      <h1>MC1life 管理面板</h1>
      <p>我的世界基岩版 1.21.90 服务器</p>
      <form @submit.prevent="login">
        <input v-model="pass" type="password" placeholder="输入管理员密码 或 访客密码" autofocus />
        <button type="submit" :disabled="!pass.trim() || busy">登录</button>
      </form>
      <p v-if="err" class="err">{{ err }}</p>
      <p class="hint">管理员密码：全部功能 | 访客密码：只读查看</p>
      <p class="hint">密码由部署时的 PANEL_AUTH_TOKEN / PANEL_VIEWER_TOKEN 配置</p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { loginWithPassword } from '../api';

const pass = ref('');
const err = ref('');
const busy = ref(false);

async function login() {
  busy.value = true; err.value = '';
  try {
    const role = await loginWithPassword(pass.value.trim());
    location.href = '/';
    console.log('登录成功, 角色:', role);
  } catch (e) {
    err.value = '密码错误';
  }
  busy.value = false;
}
</script>

<style scoped>
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #111827; }
.login-box { background: #1f2937; color: #e5e7eb; padding: 40px; border-radius: 16px; width: 340px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
.logo { font-size: 48px; }
h1 { font-size: 22px; margin: 10px 0 4px; color: #fff; }
p { font-size: 13px; color: #9ca3af; margin-bottom: 20px; }
input { width: 100%; padding: 11px 14px; border: 1px solid #374151; border-radius: 8px; background: #111827; color: #fff; font-size: 15px; outline: none; margin-bottom: 12px; }
button { width: 100%; padding: 11px; border: none; border-radius: 8px; background: #3b82f6; color: #fff; font-size: 15px; cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
.err { color: #f87171; margin-top: 10px; }
.hint { font-size: 11.5px; color: #6b7280; margin-top: 6px; }
</style>
