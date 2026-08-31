# ⛏️ MC1life — 我的世界基岩版 1.21.90 服务器 + 后台管理系统

免费方案：**Cloudflare 免费层（面板/API/备份）+ 本地（Termux）跑 BDS**

## 架构

```
玩家(手机/主机) ──UDP 19133 IPv6 直连──▶ 设备
                                       │  Termux + proot Debian + box64
                                       │  BDS 1.21.90.4 + 行为包
                                       │  Agent (Node.js 出站 WS 连接)
                                       ▼
                              Cloudflare 免费层
                    Pages 面板 · Workers API/WS · R2 备份 · D1 审计
```

- 玩家进服：IPv6 直连 `[家宽IPv6]:19133`（基岩版协议走 UDP，家宽 IPv6 免费零延迟）
- 管理通道：Agent **主动出站** WebSocket 连到 Worker —— 手机无需公网入站端口/隧道
- 备份：Agent 打包 worlds → R2（设备）

## 功能

| 模块 | 能力 |
|---|---|
| 仪表盘 | 运行状态 / 在线玩家 / 内存 / CPU / 运行时长 / 版本 |
| 控制台 | 任意指令下发 (RCON) + 实时日志流 + 常用指令提示 |
| 玩家管理 | 在线列表 / 踢人 / 封禁解封 / OP 授予撤销 |
| 存档管理 | 世界列表 / 一键切换 / URL 上传自定义存档 (.zip/.mcworld/.tar.gz) |
| 备份回滚 | 手动/定时备份 → R2（自动保留最近 N 份）/ 一键回滚 |
| 服务器设置 | server.properties 可视化编辑 + 重启生效 |
| 扩展 | 崩溃自动重启 (5s) / Agent 断线重连 / 行为包部署脚本 |

## 目录结构

```
mc1life/
├── bds/        BDS 1.21.90.4 安装/行为包部署/systemd 服务
├── agent/      Node.js 管理代理 (运行在游戏服主机)
├── worker/     Cloudflare Worker (REST API + WS 网关 + D1 schema)
├── panel/      Vue3 管理面板 (构建后发布到 CF Pages)
└── deploy/     VPS 一键部署 + CF 资源发布脚本
```

## 部署步骤

### 一、游戏服主机（本地服务器）

   实测用的是荣耀8X

> ⚠️ 性能提示：BDS 官方只有 x86_64 版，在 ARM 手机需 box64 模拟（CPU 开销约 2.5 倍）。
> 荣耀 8X（麒麟710/4GB）实测可跑小服（≤8 人，view-distance 12），但世界生成较慢。
> 内存 ≥6GB 的中端手机体验更好。

1. 安装 Termux（GitHub release APK：https://github.com/termux/termux-app/releases）
2. 把本项目放到手机存储 `/sdcard/mc1life`（git clone 或传输）
3. 在 Termux 执行一键部署：

```bash
termux-setup-storage   # 授权存储访问
bash /sdcard/mc1life/deploy/termux_setup.sh
```

脚本自动：装 proot Debian → box64 + x86 库 → 下载 BDS 1.21.90.4 → 生成低配优化配置 → 测试启动 → 打印 IPv6 连接地址。

4. 部署 Agent（管理通道）：

```bash
proot-distro login debian -- bash /sdcard/mc1life/deploy/agent_termux.sh
# 然后编辑 /opt/mc1life/agent/config.json (workerUrl/token/r2)
cd /opt/mc1life/agent && node src/index.js
```

### 二、网络（IPv6 直连）

- 手机连家里 WiFi（确认路由器开了 IPv6）
- 玩家连接地址：`[手机全局IPv6]:19133`（脚本会自动打印）
- 若玩家端无 IPv6：可改用 frp 免费服务 UDP 穿透（见 PLAN.md）

### 二、Cloudflare 侧资源

面板发布到 CF Pages（默认项目名 `mc1life-panel`），Worker 发布到 CF Workers（`mc1life-api`）。
执行 `bash deploy/cf_publish.sh <你的域名> <R2_KEY_ID> <R2_SECRET>` 自动创建资源并发布。
面板鉴权 token / Agent token 用 `wrangler secret put` 注入（见 `deploy/cf_status.md`）。

### 三、回填 Agent 配置

编辑主机上 `/opt/mc1life/agent/config.json`（参考 `config.json.example`）：

```json
{
  "workerUrl": "wss://<你的面板域名>.pages.dev/ws/agent",
  "token": "<Agent共享密钥, 与 Worker 的 AGENT_TOKEN secret 一致>",
  "agentId": "mc1life"
}
```

重启 Agent：`systemctl restart mc1life-agent`（或 Termux 下 `bash /opt/mc1life/start_agent.sh`）

### 四、行为包（可选，复用 Actions-and-Stuff）

```bash
bash bds/deploy_packs.sh /opt/mc1life/bds /workspace/mcpack_work/merged_dir
systemctl restart mc1life-bds
```

## 本地开发/测试

```bash
# Agent 冒烟测试 (mock BDS + mock RCON + mock Worker)
cd agent && bash test/run_smoke.sh

# Worker REST 验证 (Node 直跑 Hono)
cd worker && bash test/run_rest_test.sh

# 面板本地开发
cd panel && npm run dev   # 代理 /api 到本地 worker
```

## 安全说明

- Agent 令牌即管理权限，务必用强随机值并走 `wrangler secret`
- 面板建议叠加 **Cloudflare Access**（免费 50 用户）做登录保护
- R2 备份含完整存档，密钥不要外泄
- Oracle 免费实例可能被回收，建议定期手动备份 + 保留 R2 冗余

## 已知限制

- Cloudflare Workers 无法运行 Minecraft 服务端（无状态/CPU 上限/无 UDP）→ 游戏服必须在 VPS/云主机
- Cloudflare Tunnel 不支持 UDP → 玩家需直连主机 IP，无法套 CF 加速游戏流量
- 免费 R2 10GB 存储，按备份轮转策略控制用量
