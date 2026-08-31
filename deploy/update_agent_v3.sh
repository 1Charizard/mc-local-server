#!/usr/bin/env bash
# MC1life - Agent v3 快速更新 (在 Termux 宿主运行, 自动找包/停旧/备份/解压/合并配置/启动)
# 用法: bash update_agent_v3.sh
set -uo pipefail
log()  { echo -e "\e[1;32m[MC1life]\e[0m $*"; }
fail() { echo -e "\e[1;31m[MC1life 错误]\e[0m $*" >&2; exit 1; }

# ---- 1. 找 Agent 包 (支持多种目录) ----
AGENT_TAR=""
for p in \
  /storage/emulated/0/mc1life_offline_pack/mc1life-agent-v3.tar.gz \
  /storage/emulated/0/offline_pack/mc1life-agent-v3.tar.gz \
  /storage/emulated/0/mc1life_offline_pack_full_v3/offline_pack/mc1life-agent-v3.tar.gz \
  /storage/emulated/0/offline_pack/mc1life-agent.tar.gz \
  /storage/emulated/0/mc1life_offline_pack/mc1life-agent.tar.gz ; do
  if [ -f "$p" ]; then AGENT_TAR="$p"; break; fi
done
[ -n "$AGENT_TAR" ] || fail "未找到 Agent 包 (请把 mc1life-agent-v3.tar.gz 放到 内部存储/mc1life_offline_pack/)"
log "Agent 包: ${AGENT_TAR}"
PKG_DIR="$(dirname "$AGENT_TAR")"

# ---- 2. 找容器 ----
DISTRO=""
for c in debian-trixie-aarch64 debian-trixie debian; do
  if timeout 30 proot-distro login "$c" -- true >/dev/null 2>&1; then DISTRO="$c"; break; fi
done
[ -n "$DISTRO" ] || fail "未找到 Debian 容器"
log "容器: ${DISTRO}"

# ---- 3. 容器内更新 (heredoc 传脚本, 避免 pkill 自杀) ----
log "更新 Agent (停旧 -> 备份 -> 解压 -> 合并配置 -> 校验)..."
timeout 300 proot-distro login --bind "${PKG_DIR}:/opt/pack" "$DISTRO" -- bash -s <<'INNER'
set -e
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
NODE=/opt/node/bin/node
log() { echo -e "\e[1;34m[MC1life-Debian]\e[0m $*"; }

log "停止旧 Agent..."
pkill -f "node src/index.js" 2>/dev/null || true
sleep 1

AGENT_DIR=/opt/mc1life/agent
if [ -d "$AGENT_DIR" ]; then
  BK="${AGENT_DIR}.bak-$(date +%Y%m%d%H%M%S)"
  log "备份旧版 -> ${BK}"
  mv "$AGENT_DIR" "$BK"
fi
mkdir -p "$AGENT_DIR"

# 解压 (优先 v3 包名)
if [ -f /opt/pack/mc1life-agent-v3.tar.gz ]; then
  tar xzf /opt/pack/mc1life-agent-v3.tar.gz -C "$AGENT_DIR"
  log "已解压 mc1life-agent-v3.tar.gz"
else
  tar xzf /opt/pack/mc1life-agent.tar.gz -C "$AGENT_DIR"
  log "已解压 mc1life-agent.tar.gz"
fi

# 合并旧配置: 保留凭证 (token/r2), 强制 workerUrl=pages.dev
if [ -f "${BK}/config.json" ]; then
  log "合并旧配置 (保留凭证, 强制 pages.dev)..."
  BK="$BK" ${NODE} - <<'NODEEOF'
const fs = require('fs');
const old = JSON.parse(fs.readFileSync(process.env.BK + '/config.json', 'utf8'));
const fresh = JSON.parse(fs.readFileSync('/opt/mc1life/agent/config.json.example', 'utf8'));
const merged = { ...fresh, ...old, hardcore: { ...fresh.hardcore, ...(old.hardcore || {}) } };
merged.workerUrl = fresh.workerUrl; // 强制 pages.dev (旧 workers.dev 手机连不上)
fs.writeFileSync('/opt/mc1life/agent/config.json', JSON.stringify(merged, null, 2));
console.log('合并完成, workerUrl:', merged.workerUrl);
NODEEOF
else
  [ -f /opt/mc1life/agent/config.json ] || cp /opt/mc1life/agent/config.json.example /opt/mc1life/agent/config.json
fi

log "校验新版语法..."
"${NODE}" --check "$AGENT_DIR/src/index.js"
"${NODE}" --check "$AGENT_DIR/src/ws.js"
echo "PollClient 标记: $(grep -c PollClient "$AGENT_DIR/src/ws.js")"

cat > /opt/mc1life/start_agent.sh <<'AGEOF'
#!/usr/bin/env bash
cd /opt/mc1life/agent
export PATH=/opt/node/bin:$PATH
exec /opt/node/bin/node src/index.js >> /opt/mc1life/agent.log 2>&1 &
echo "Agent PID: $!"
AGEOF
chmod +x /opt/mc1life/start_agent.sh

echo "UPDATE_DONE"
INNER
[ $? -eq 0 ] || fail "容器内更新失败 (见上方输出)"

# ---- 4. detach 常驻启动 ----
log "启动新版 Agent (detach 常驻)..."
proot-distro login -d "$DISTRO" -- bash -c 'cd /opt/mc1life/agent && export PATH=/opt/node/bin:$PATH && exec node src/index.js >> /opt/mc1life/agent.log 2>&1'
sleep 12
log "Agent 日志:"
proot-distro login "$DISTRO" -- tail -8 /opt/mc1life/agent.log || true
log "完成! 若看到 '轮询模式启动' 即成功"
