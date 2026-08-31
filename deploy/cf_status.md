# Cloudflare 侧部署状态 (2026-08-30)

## 已完成
- ✅ Pages 面板 (含登录鉴权 + API/WS 代理): https://mc1life-panel.pages.dev
- ✅ Worker 后端 (REST + WS + D1 + KV): https://mc1life-api.mc1life.workers.dev
- ✅ D1 数据库 mc1life (audit_log/settings/tasks 三表已建)
- ✅ KV namespace SESSION_KV
- ✅ workers.dev 子域名: mc1life.workers.dev
- ✅ Secrets: AGENT_TOKEN / PANEL_JWT_SECRET / PANEL_AUTH_TOKEN (在 .credentials/agent.env)
- ✅ 面板鉴权: /api/* 需 Authorization: Bearer <PANEL_AUTH_TOKEN>

## 待办
- ⏳ R2 bucket mc1life-backups: 需在 CF Dashboard 启用 R2 后创建
- ⏳ Agent 部署 (需 Oracle SSH)
- ⏳ BDS 部署 (需 Oracle SSH)
