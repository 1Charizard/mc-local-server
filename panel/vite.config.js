import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 面板构建产物由 Cloudflare Pages 托管
// API 地址可通过环境变量注入, 默认同域 /api (通过 Pages Functions 或同域 worker)
export default defineConfig({
  plugins: [vue()],
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET || 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: process.env.VITE_API_TARGET || 'http://localhost:8787', ws: true },
    }
  }
});
