# MC1life — 部署方案演进记录

> 更新于 2026-09-08 · 当前阶段：**Phase 0 完成（Paper 迁移）→ 生产运行于阿里云 ECS**

## 阶段总览

| 阶段 | 方案 | 状态 |
|---|---|---|
| v1 | CF Workers 全托管 | ❌ Workers 跑不了游戏服 |
| v2 | 旧安卓手机 (Termux+box64) + BDS + IPv6 直连 | ✅ 跑通过，性能受限 |
| **Phase 0 (当前)** | **阿里云 ECS + Paper 26.2 + Geyser 双端互通** | ✅ **生产运行中** |

## Phase 0: Paper 迁移（当前）

### 动机
- 基岩 BDS 无法与 Java 玩家互通；Geyser + Paper 实现双端同服
- box64 模拟 x86 BDS CPU 开销 2.5 倍，2核机扛不住；Paper 是原生 aarch64 Java
- 阿里云 2核/1.6G ECS 代替手机 7×24 开机

### 完成项
- [x] swap 2G + JDK 25 + 全量备份
- [x] Paper 26.2 (build 121) + Geyser 2.11.2 + Floodgate 2.2.5
- [x] 双端进服验证（Java 1.21.x 电脑 + 基岩 1.21.90 手机）
- [x] Agent paper 引擎模式（RCON/Done 检测/世界 symlink 切换/玩家列表）
- [x] 包管理 Java 化（数据包 + 双平台材质包分类）
- [x] 存档导入分流（基岩档自动进待转换区防崩）
- [x] 玩家列表修复（Paper list 输出无问号的正则适配）
- [x] 性能调优：G1GC 替换 SerialGC + 实体/合并参数（见 java/README.md）

### 已知问题
- 1.6G 内存偏紧（RSS ~1.1G），人多会 thrash —— 长期建议升级 4G
- 中文玩家名无法连 Java 端（需英文 ID；基岩经 Floodgate 自动前缀）
- 基岩存档需转换工具（Chunker 等）转 Java 格式才能加载

---

# 以下为历史方案存档（v2: 手机部署）

## 0. 方案变更原因

用户选择「本地部署 + 内网穿透」：旧安卓手机跑 BDS，玩家从外网连入。

## 1. 已探明事实

### 1.1 设备侧（Termux 跑 BDS 可行性）
- ✅ box64（x86_64 模拟器）有官方 ARM64 版本与 **x86 库包**（`box64-bundle-x86-libs`，GitHub 可达）
- ✅ Termux + proot-distro Debian + box64 是社区跑 BDS 的标准路径
- ⚠️ BDS 官方仅有 x86_64 二进制，box64 模拟有性能损耗（约 2-3 倍 CPU 开销）
- ⚠️ BDS 1.21.90 需要 ≥1GB 可用内存（开服后 2-4GB），**旧手机需 ≥4GB RAM 才能顺畅**
- ⚠️ 当前沙箱网络连不上 minecraft.net（BDS zip 需在用户手机网络下载，或走镜像）

### 1.2 网络侧（内网穿透）
- 当前出口 IP `60.249.101.31` 是运营商 NAT（非公网）
- **管理通道无需穿透**：Agent 是出站 WebSocket 连 Cloudflare Worker（面板已上线）
- **只有游戏流量（UDP 19132）需要对外可达**

### 1.3 内网穿透候选（按推荐度）

| 方案 | 条件 | 优点 | 缺点 |
|---|---|---|---|
| **IPv6 直连** | 宽带支持 IPv6（国内基本都有） | 零成本/零延迟/无需中转 | 玩家端需 IPv6（手机流量/家宽基本都有） |
| **公网 IPv4 端口映射** | 宽带是公网 IPv4 | 最稳定 | 国内家宽多数是 NAT，需致电运营商 |
| **frp 免费服务** (OpenFrp 等) | 无公网 IP 时 | 免费节点支持 UDP | 延迟/限速/不稳定，仅备用 |
| **frp 自建** | 需一台有公网 IP 的服务器 | 稳定可控 | 无 VPS 资源，放弃 |

## 2. 待用户确认（阻塞项）

1. **旧手机配置**：型号 / RAM / Android 版本 / 是否可 7×24 插电开机（决定 BDS 能否跑动）
2. **家里网络**：让用户在手机连 WiFi 后执行检测（见 3.2），确认有无 IPv6 / 公网 IPv4

## 3. 实施步骤

### 3.1 手机端准备
1. 安装 Termux（GitHub release APK，国内商店无新版）
2. `pkg install proot-distro` → 安装 Debian
3. Debian 内安装 box64（ryanfortner/box64-debs）+ 下载 box64-bundle-x86-libs 解压
4. 下载 BDS 1.21.90.4 zip（手机网络可直连 minecraft.net；若不可用则从 GitHub 镜像/网盘获取）→ 解压到 `~/bds`
5. 运行 `./bedrock_server` 验证 "Server started"

### 3.2 网络检测（用户在手机执行）
```
# 手机连 WiFi 后：
# 1. 测 IPv6:   浏览器打开 https://test-ipv6.com  看是否有 IPv6 地址
# 2. 看出口IP:  浏览器打开 https://ip.sb 或 ip.sb 命令行
# 3. 对比路由器: 登录路由器(192.168.1.1) 看 WAN IP 是否与出口 IP 相同
#    - 相同 → 公网 IPv4，直接端口映射
#    - 不同 → NAT，看 IPv6 是否可用
```

### 3.3 穿透配置（按检测结果三选一）
- **有 IPv6**：BDS `server.properties` 设 `server-portv6=19133`，玩家连 `[IPv6地址]:19133`
- **有公网 IPv4**：路由器 DMZ/端口映射 UDP 19132 → 手机
- **都没有**：OpenFrp 免费节点 UDP 穿透（注册账号，配置 frpc）

### 3.4 管理通道（已有，无需穿透）
- Agent 出站 WS → `https://mc1life-api.mc1life.workers.dev/ws/agent`
- 面板：https://mc1life-panel.pages.dev （已部署，登录密码在 .credentials/agent.env）

### 3.5 Agent 部署（手机上）
- 安装 Node.js for Termux（`pkg install nodejs`）
- 将本项目 agent/ 放到手机，填 config.json（workerUrl/token/r2），`node src/index.js`

## 4. 风险

| 风险 | 对策 |
|---|---|
| 旧手机内存不足跑不动 BDS | 先确认 RAM≥4GB；不行则降版本或用电脑 |
| box64 模拟性能差 | 限制 max-players/view-distance；接受小服规模 |
| 手机无公网 IPv4/IPv6 | frp 免费服务兜底，但体验打折 |
| 手机不能长期开机 | 需用户确认能 7×24 插电 + 锁屏保持运行（Termux 需 wakelock） |
| minecraft.net 在手机网络不可达 | 用 GitHub 镜像/网盘下载 BDS zip |
