# 参与贡献

感谢你愿意为 MC1life 贡献代码！请遵守以下规范。

## 安全第一

本项目涉及**服务器管理与存档数据**，任何提交**严禁包含**：

- Agent/Worker/面板的 token、密码、secret（一律用环境变量或占位符）
- Cloudflare API Token / R2 访问密钥
- 真实部署域名（用 `<YOUR_DOMAIN>` 等占位符）
- 玩家存档、行为包等第三方版权内容

提交前请自查：
```bash
grep -rnE "cfat_|sk-[A-Za-z0-9]|ghp_|AKIA[0-9A-Z]" --include="*.js" --include="*.json" --include="*.sh" .
```

## 分支与提交

- 主分支 `main`，新功能请开分支再提 PR
- 提交信息用中文或英文均可，但须清晰描述改动
- 保持单一职责：一个 PR 只做一件事

## 代码风格

- Node.js / Worker：ES Module（worker/）、CommonJS（agent/，手机环境兼容）
- Vue 面板：`<script setup>` 组合式 API
- 缩进 2 空格，字符串用单引号（面板内既有代码保持原样）

## 测试

- Agent：`cd agent && bash test/run_smoke.sh`（mock BDS/RCON/Worker）
- Worker：`cd worker && bash test/run_rest_test.sh`
- 面板：`cd panel && npm run dev` 本地调试

## 部署验证

改动涉及部署脚本时，请在真实 Termux/CF 环境验证通过后再提 PR。

## 问题与讨论

- Bug 报告 / 功能建议 → GitHub Issues
- 架构讨论 → Discussions
