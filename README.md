# ⛏️ MC1life — 我的世界双端互通服务器 + 网页管理面板

Java 版（Paper）+ 基岩版（Geyser 互通）双端同服，Cloudflare 免费层承载管理面板/API。

> 当前生产：阿里云 ECS（2核/1.6G/Ubuntu）跑 **Paper 26.2 + Geyser 2.11 + Floodgate 2.2**
> 电脑玩家（Java 1.21.x）与手机玩家（基岩 1.21.90）同世界联机

## 架构

```
Java 玩家 (电脑) ──TCP 25565──┐
                              ├──▶ 阿里云 ECS (121.43.x.x)
基岩玩家 (手机) ──UDP 19132──┤      │  Paper 26.2 (Java 服务端)
                              │      │  + Geyser (基岩协议转译)
                              │      │  + Floodgate (基岩登录免 Java 账号)
                              │      │  + Agent (Node.js, systemd 托管)
                              ▼      ▼
                       Cloudflare 免费层
              Pages 面板 · Workers API · D1 (指令队列/审计/分片)
```

- **管理通道**：Agent 主动出站 HTTPS 轮询 Worker（服务器无需开放额外管理端口）
- **上传/备份/导出**：分片经 D1 staging 中转（绕开 R2 TLS 阻断与 CF 100MB 单请求限制）
- **玩家连接**：
  - Java：`121.43.166.46:25565`（协议兼容 1.21 ~ 1.21.10）
  - 基岩：`121.43.166.46:19132`（Geyser 转译）

## 功能

| 模块 | 能力 |
|---|---|
| 仪表盘 | 运行状态 / 在线玩家 / 内存 / CPU / 运行时长 / 版本 |
| 控制台 | 任意指令下发 (RCON) + 实时日志流 + 常用指令提示 |
| 玩家管理 | 在线列表 / 踢人 / 封禁（永久/限时/解封/改时间） / OP 授予撤销（游戏内通知） |
| 存档管理 | 世界列表 / 切换 / 重命名 / 删除 / 网页分片上传（≤500MB）/ URL 拉取 / 导出下载 |
| 备份回滚 | 手动备份 → Worker 分片通道（自动保留 N 份）/ 一键回滚 |
| 死亡备份 | 玩家死亡自动快照（背包/血量/位置），面板独立开关 |
| 组件库 | 数据包（Java）/ 双平台材质包分类上传，按世界独立启停 |
| 硬核模式 | 可开关；wipe（删档）/ ban（封禁）两种惩罚 |
| 服务器设置 | server.properties / spigot.yml 可视化编辑 + 重启生效 |

## 目录结构

```
mc1life/
├── agent/      Node.js 管理代理（跑在游戏服主机，systemd: mc1life-agent）
├── worker/     Cloudflare Worker（REST API + 指令队列 + 分片 staging）
├── panel/      Vue3 管理面板（构建后发布 CF Pages，_worker.js 代理 /api）
├── bds/        旧 BDS 方案存档（已迁 Paper，保留参考）
├── deploy/     Termux/VPS/CF 部署脚本
└── java/       Paper 服务端部署说明与调优记录（服务器生成，配置文档化在此）
```

## 部署步骤

### 一、游戏服主机（阿里云 ECS / 任意 VPS）

要求：1G 内存起步（推荐 ≥2G）；Java 21+（Paper 26.2 实测用 JDK 25）。

```bash
# 1. 基础环境
apt update && apt install -y openjdk-25-jre-headless nodejs npm

# 2. 用户与目录
useradd -r -m mc1life
mkdir -p /opt/mc1life/{java,agent,worlds}

# 3. Paper 服务端（自动下载 jar + 接受 eula）
cd /opt/mc1life/java
# 从 https://papermc.io/downloads 下载 paper-<version>.jar 重命名 paper.jar
echo "eula=true" > eula.txt

# 4. Geyser + Floodgate 插件（基岩互通）
mkdir plugins && cd plugins
wget https://download.geysermc.org/v2/projects/geyser/regions/builds/latest/downloads/spigot -O Geyser.jar
wget https://download.geysermc.org/v2/projects/floodgate/regions/builds/latest/downloads/spigot -O Floodgate.jar

# 5. Agent
cp -r <repo>/agent /opt/mc1life/agent
cd /opt/mc1life/agent && npm ci
cp config.json.example config.json   # 填 workerUrl/token
cp <repo>/agent/mc1life-agent.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now mc1life-agent
```

> Agent 会自动拉起 Paper（`run.sh`），Paper 崩溃自动重启（5s），无需单独的 server systemd。

### 二、JVM 启动参数（1.6G 小内存机实测调优）

见 `java/run.sh` 文档说明：G1GC 低停顿 + 固定堆，**小服卡顿的关键在 GC 算法**。
大内存机器（≥4G）可换回常规参数：`-Xms2G -Xmx2G -XX:+UseG1GC`。

### 三、Cloudflare 侧资源

```bash
export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account>
cd worker && npx wrangler deploy                          # API
npx wrangler pages deploy ../panel/dist --project-name mc1life-panel   # 面板
npx wrangler d1 execute mc1life --file=./schema.sql --remote           # D1 建表
```

Secrets 注入（不要写进仓库）：`AGENT_TOKEN` / `PANEL_JWT_SECRET` / `PANEL_AUTH_TOKEN` / `PANEL_VIEWER_TOKEN`。

### 四、安全组/防火墙放行

| 端口 | 协议 | 用途 |
|---|---|---|
| 22 | tcp | SSH 管理 |
| 25565 | tcp | Java 玩家 |
| 19132 | udp | 基岩玩家 (Geyser) |
| 8080 | tcp | 材质包静态分发（基岩端在线装包） |

## 性能调优（1.6G 内存 2核机实测）

完整参数与原理见 [`java/README.md`](java/README.md)。要点：

- **G1GC 替换 SerialGC** —— Serial 全停顿回收是小服卡顿主因
- 实体激活范围 32→16、刷怪范围 8→4、物品合并 0.5→3.5
- `prevent-moving-into-unloaded-chunks=true`、`optimize-explosions=true`
- Geyser `max-players` 100→20（虚高配置白占内存）
- 视距 view-distance=4 / simulation-distance=3（低配机的合理取舍）

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

- 所有凭证走 `wrangler secret` / 服务器本地 `config.json`，**仓库内无任何明文密钥**
- Agent 令牌即管理权限，务必强随机
- 面板建议叠加 Cloudflare Access（免费 50 用户）
- `.credentials/` 目录已 gitignore，仅存在于本地工作区

## 已知限制

- 中文玩家名无法进 Java 端（Floodgate 已缓解：基岩玩家自动加前缀，Java 端需英文 ID）
- 基岩存档不能直接给 Paper 加载 —— 需先用转换工具（如 Chunker）转 Java 格式
- CF Workers 无法跑游戏服（无 UDP/CPU 上限）—— 游戏服必须在 VPS/云主机
- 1.6G 内存机适合 ≤4 人小服；人多请升级内存（长期方案 4G+）
