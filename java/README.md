# java/ — Paper 服务端部署与调优

> 生产环境：阿里云 ECS 2核 / 1.6G 内存 / Ubuntu，Paper 26.2 + Geyser 2.11.2 + Floodgate 2.2.5

## 目录布局（服务器 /opt/mc1life/java/）

```
/opt/mc1life/java/
├── paper.jar              # Paper 26.2 (build 121)
├── run.sh                 # JVM 启动脚本 (Agent spawn, 见下)
├── console.log            # tee 出的控制台日志 (排障用)
├── server.properties      # server-port=25565, online-mode=false(靠插件鉴权)
├── spigot.yml             # 实体激活/合并半径等 (调优见下)
├── bukkit.yml             # connection-throttle=4000
├── config/paper-global.yml
├── config/paper-world-defaults.yml
├── plugins/
│   ├── Geyser.jar         # 2.11.2 — 基岩协议转译 (UDP 19132)
│   └── Floodgate.jar      # 2.2.5 — 基岩玩家免 Java 账号登录
├── plugins/Geyser-Spigot/config.yml
├── worlds/ -> /opt/mc1life/worlds   # 世界库 (symlink 由 Agent 管理)
└── world -> worlds/<当前世界名>     # Agent 切换世界 = 改这个 symlink + 重启
```

## run.sh — JVM 参数（1.6G 内存机实测）

```bash
java -Xms896M -Xmx896M \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=40 \
  -XX:G1HeapRegionSize=1M \
  -XX:MaxTenuringThreshold=2 \
  -XX:+ParallelRefProcEnabled \
  -XX:MaxMetaspaceSize=256M \
  -Dfile.encoding=UTF-8 \
  -jar paper.jar nogui
```

### 为什么是这些参数（踩坑记录）

| 参数 | 原因 |
|---|---|
| `-Xms896M -Xmx896M`（固定堆） | 弹性堆（384~768M）在内存紧张时反复伸缩，加剧 GC 压力。固定后 JVM 不再花时间扩/缩堆。896M = 总内存 1.6G - 系统/Agent/Geyser 开销的平衡点 |
| `-XX:+UseG1GC` | **核心优化**。原 SerialGC 回收时全停顿（world stop），内存越大停顿越久 —— 小服卡顿主因。G1 并发回收 + 可设停顿目标 |
| `-XX:MaxGCPauseMillis=40` | 告诉 G1 尽量把单次停顿控制在 40ms 内（约 1 tick），玩家体感不掉帧 |
| `-XX:G1HeapRegionSize=1M` | 1.6G 小堆用小 region，回收粒度细，避免大块停顿 |
| `-XX:MaxTenuringThreshold=2` | 短命对象（方块更新/实体快照）快速晋升老年代，减少反复复制 |
| `-XX:+ParallelRefProcEnabled` | 引用处理并行化，缩短停顿 |
| ~~`-XX:G1NewSizePercent` 等实验参数~~ | ⚠️ JDK25 下未开 `UnlockExperimentalVMOptions` 会直接 JVM 拒绝启动（踩过：`Improperly specified VM option`）。要么删掉这些参数，要么加解锁参数。当前选择了删除（默认值已够用） |

**大内存机器（≥4G）推荐**：`-Xms2G -Xmx2G -XX:+UseG1GC -XX:MaxGCPauseMillis=50`，其余默认即可。

## spigot.yml 调优

```yaml
merge-radius:
  item: 3.5      # 0.5 -> 3.5: 地上掉落物快速合并, 减少实体数
  exp: -1.0
mob-spawn-range: 4   # 8 -> 4: 刷怪范围减半
entity-activation-range:
  animals: 16    # 32 -> 16: 动物 AI 激活范围
  monsters: 16   # 32 -> 16: 怪物 AI 激活范围
  misc: 16
  villagers: 32  # 村民交易要灵敏, 保留 32
```

## paper-world-defaults.yml

```yaml
chunks:
  prevent-moving-into-unloaded-chunks: true   # 防跑太快进未加载区块导致卡死/坠落
misc:
  optimize-explosions: true   # TNT/苦力怕爆炸不逐块计算
```

## server.properties（安全相关）

```properties
server-ip=            # 留空监听所有网卡
server-port=25565
online-mode=false     # 关正版验证 (Floodgate 必需; Java 端靠白名单/封禁系统管人)
enable-query=false    # 关无用查询服务
max-players=12
view-distance=4       # 低配机取舍 (默认 10)
simulation-distance=3
```

## Geyser (plugins/Geyser-Spigot/config.yml)

```yaml
max-players: 20    # 100 -> 20: 默认虚高, 白占内存
```

## 验证清单（改完配置后）

```bash
# 1. Paper 启动成功 (预期 70-80s)
grep 'Done (' /opt/mc1life/java/console.log

# 2. G1GC 生效
ps -ef | grep '[p]aper.jar' | grep -o UseG1GC

# 3. 内存水位 (RSS 应 < 1.2G, 系统 available > 200M)
ps -o rss= -p $(pgrep -f paper.jar) | awk '{printf "%.0fMB\n", $1/1024}'
free -m

# 4. 外网握手 (任意 Java 1.21+ 客户端或 mcsstatus 工具)
#    MOTD 应返回 {"version":{"name":"Paper 26.2","protocol":776}}

# 5. 面板状态在线
curl -H "Authorization: Bearer $PANEL_AUTH_TOKEN" https://mc1life-panel.pages.dev/api/status
```

## 备份位置

改配置前先备份（服务器 root 下）：
```bash
cp /opt/mc1life/java/{run.sh,spigot.yml} /root/backups/ --backup=numbered
```
