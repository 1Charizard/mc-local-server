#!/usr/bin/env bash
# MC1life - 离线安装脚本 v20 (完整包: 全新安装 或 旧版 Agent 自动升级)
# v20 变更 (相对 v19):
#   - Agent 包升级为 v2 (含 hardcore.js 极限模式 + 面板网页上传存档支持)
#   - 幂等检查区分 Agent 版本: 已装旧版 Agent 时自动执行"仅更新 Agent"分支
#     (停旧 -> 解压新版 -> node 合并保留 config.json 凭证 -> 重启)
#   - 全新安装流程与 v19 一致 (全程离线)
# 用法: bash offline_setup.sh  (与离线文件同目录)
set -uo pipefail

MC1LIFE_SCRIPT_VERSION="v20"
log()  { echo -e "\e[1;32m[MC1life]\e[0m $*"; }
warn() { echo -e "\e[1;33m[MC1life 提示]\e[0m $*"; }
fail() { echo -e "\e[1;31m[MC1life 错误]\e[0m $*" >&2; exit 1; }
show_usage() {
  echo
  log "════════════════════════════════════════════════════"
  log " ✅ 全部安装完成!"
  log ""
  log " ▶ 启动服务器 (第一次生成世界需 1-2 分钟):"
  log "    proot-distro login ${1} -- bash /opt/mc1life/bds/run.sh"
  log ""
  log " ▶ 启动后台 Agent (管理通道):"
  log "    proot-distro login ${1} -- bash /opt/mc1life/start_agent.sh"
  log "    查看日志: proot-distro login ${1} -- tail -f /opt/mc1life/agent.log"
  log ""
  log " ▶ 玩家连接: [你的IPv6地址]:19133  (查询: proot-distro login ${1} -- hostname -I)"
  log "════════════════════════════════════════════════════"
}

[ -n "${PREFIX:-}" ] || fail "请在 Termux 中运行"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"
log "脚本版本: ${MC1LIFE_SCRIPT_VERSION}"

# ---- 0. 检查离线文件 ----
for f in debian-trixie-aarch64.tar.xz box64.deb x86libs.tar.gz bds-1.21.90.4.zip; do
  [ -f "${f}" ] || fail "缺少文件: ${f} (请与脚本同一目录)"
done
DEB_COUNT=0; [ -d debs ] && DEB_COUNT="$(ls debs/*.deb 2>/dev/null | wc -l)"
[ "${DEB_COUNT}" -gt 0 ] || fail "缺少 debs/*.deb (amd64 系统库 + unzip), BDS 无法启动"
NODE_TAR="$(ls node-*-linux-arm64.tar.gz 2>/dev/null | head -1 || true)"
[ -n "${NODE_TAR}" ] || fail "缺少 Node.js 离线包 (node-*-linux-arm64.tar.gz)"
[ -f mc1life-agent.tar.gz ] || fail "缺少 mc1life-agent.tar.gz (Agent + node_modules + config)"
log "离线文件检查通过 ✅ (amd64 库 ${DEB_COUNT} 个, Node: ${NODE_TAR})"

# ---- 0.5 proot-distro 就绪 ----
command -v proot-distro >/dev/null 2>&1 || {
  log "安装 proot-distro ..."
  apt update -y >/dev/null 2>&1 || true
  apt install -y proot-distro 2>&1 | tail -1 || fail "proot-distro 安装失败"
}
log "proot-distro: $(command -v proot-distro)"

# ---- 1. 容器检测 ----
DISTRO=""
for c in debian-trixie-aarch64 debian-trixie debian; do
  if timeout 30 proot-distro login "${c}" -- true >/dev/null 2>&1; then
    DISTRO="${c}"
    log "检测到容器 (login 实测): ${DISTRO}"
    break
  fi
done
if [ -z "${DISTRO}" ]; then
  DISTRO="$(proot-distro list 2>&1 | grep -oE 'debian[a-zA-Z0-9._-]*' | head -1 || true)"
  if [ -n "${DISTRO}" ]; then
    log "检测到容器 (proot-distro list): ${DISTRO}"
  fi
fi

if [ -z "${DISTRO}" ]; then
  log "未检测到 Debian 容器, proot-distro install 本地 rootfs..."
  LOCAL_TAR="$(readlink -f "${SCRIPT_DIR}/debian-trixie-aarch64.tar.xz")"
  timeout 300 proot-distro install "${LOCAL_TAR}" 2>&1 | tail -8 || fail "proot-distro install 失败 (见上方输出)"
  DISTRO="$(proot-distro list 2>&1 | grep -oE 'debian[a-zA-Z0-9._-]*' | head -1 || true)"
  [ -n "${DISTRO}" ] || fail "无法找到已安装的 debian 容器"
fi
log "容器名: ${DISTRO}"

# ---- 2. 冒烟 ----
log "proot-distro login 冒烟测试..."
if timeout 90 proot-distro login "${DISTRO}" -- /bin/bash -c 'echo "LOGIN_OK $(uname -m) | $(head -1 /etc/os-release)"' 2>&1; then
  log "登录成功 ✅"
else
  fail "proot-distro login 失败 (见上方输出)。请把完整输出发给我"
fi

# ---- 2.5 幂等 + Agent 版本检测 ----
AGENT_ONLY=0
if timeout 60 proot-distro login "${DISTRO}" -- /bin/bash -c 'test -x /opt/mc1life/bds/run.sh && test -x /opt/mc1life/agent/src/index.js && echo ALL_READY || echo INCOMPLETE' 2>/dev/null | grep -q ALL_READY; then
  if timeout 30 proot-distro login "${DISTRO}" -- /bin/bash -c 'test -f /opt/mc1life/agent/src/hardcore.js && echo V2 || echo OLD' 2>/dev/null | grep -q V2; then
    log "检测到 BDS + 新版 Agent (v2) 已安装, 跳过安装"
    show_usage "${DISTRO}"
    exit 0
  else
    log "检测到已安装但 Agent 是旧版 (缺 hardcore.js), 仅更新 Agent..."
    AGENT_ONLY=1
  fi
fi

# ---- 3. 内部安装 (全程离线) ----
log "生成内部安装脚本 install_inner.sh ..."
cat > "${SCRIPT_DIR}/install_inner.sh" <<'INNER_EOF'
#!/usr/bin/env bash
set -e
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
log() { echo -e "\e[1;34m[MC1life-Debian]\e[0m $*"; }

# ---------- 仅更新 Agent 分支 ----------
AGENT_ONLY="__AGENT_ONLY__"
if [ "${AGENT_ONLY}" = "1" ]; then
  AGENT_DIR=/opt/mc1life/agent
  log "仅更新 Agent: 停旧 Agent..."
  pkill -f "node src/index.js" 2>/dev/null || true
  sleep 1
  if [ -d "${AGENT_DIR}" ]; then
    BK="${AGENT_DIR}.bak-$(date +%Y%m%d%H%M%S)"
    log "备份旧版到 ${BK}"
    mv "${AGENT_DIR}" "${BK}"
  fi
  mkdir -p "${AGENT_DIR}"
  tar xzf /opt/pack/mc1life-agent.tar.gz -C "${AGENT_DIR}"
  # 合并旧 config.json (保留凭证, 补 hardcore 等新字段)
  if [ -f "${BK}/config.json" ]; then
    log "合并旧配置 (保留凭证)..."
    BK="${BK}" /opt/node/bin/node - <<'NODEEOF'
const fs = require('fs');
const old = JSON.parse(fs.readFileSync(process.env.BK + '/config.json', 'utf8'));
const fresh = JSON.parse(fs.readFileSync('/opt/mc1life/agent/config.json.example', 'utf8'));
const merged = { ...fresh, ...old, hardcore: { ...fresh.hardcore, ...(old.hardcore || {}) } };
fs.writeFileSync('/opt/mc1life/agent/config.json', JSON.stringify(merged, null, 2));
console.log('config.json 合并完成, hardcore:', JSON.stringify(merged.hardcore));
NODEEOF
  else
    [ -f /opt/mc1life/agent/config.json ] || cp /opt/mc1life/agent/config.json.example /opt/mc1life/agent/config.json
  fi
  # 校验 + 重启
  log "校验新版语法..."
  node --check "${AGENT_DIR}/src/index.js"
  node --check "${AGENT_DIR}/src/hardcore.js"
  cat > /opt/mc1life/start_agent.sh <<'AGEOF'
#!/usr/bin/env bash
cd /opt/mc1life/agent
export PATH=/opt/node/bin:$PATH
nohup node src/index.js >> /opt/mc1life/agent.log 2>&1 &
echo "Agent PID: $!"
AGEOF
  chmod +x /opt/mc1life/start_agent.sh
  /opt/mc1life/start_agent.sh
  sleep 3
  log "Agent 日志:"
  tail -5 /opt/mc1life/agent.log || true
  echo "INSTALL_INNER_DONE"
  exit 0
fi

# --- box64 (arm64 原生) ---
log "安装 box64 ..."
dpkg -i /opt/pack/box64.deb 2>/dev/null || {
  apt-get install -f -y -qq >/dev/null 2>&1 || true
  dpkg -i /opt/pack/box64.deb
}
command -v box64 && box64 --version 2>/dev/null | head -1 || echo "box64 路径: $(command -v box64)"

# --- 关键: 注册 amd64 架构 (装 amd64 库的前提) ---
log "注册 amd64 架构 ..."
dpkg --add-architecture amd64
dpkg --print-foreign-architectures

# --- amd64 系统库 + arm64 unzip (一次 dpkg 装全部, 互相解析依赖) ---
log "安装 amd64 系统库 + unzip ..."
dpkg -i --force-depends /opt/pack/debs/*.deb 2>&1 | tail -2 || {
  apt-get install -f -y -qq >/dev/null 2>&1 || true
  dpkg -i --force-depends /opt/pack/debs/*.deb
}
ls /usr/lib/x86_64-linux-gnu/libc.so.6 >/dev/null 2>&1 && echo "amd64 libc 就绪 ✅" || echo "警告: libc.so.6 未找到"
command -v unzip >/dev/null 2>&1 && echo "unzip 就绪 ✅" || echo "警告: unzip 未安装"

# --- box64 兼容修复: libldap 补 libresolv 依赖 (dn_expand 符号) ---
if [ -f /opt/pack/patched/libldap-2.5.so.0 ]; then
  cp -f /opt/pack/patched/libldap-2.5.so.0 /usr/lib/x86_64-linux-gnu/libldap-2.5.so.0
  echo "libldap-2.5 patched ✅ (libresolv 依赖已补, 修复 dn_expand)"
fi

# --- x86libs bundle ---
log "解压 x86 库到 /opt/x86libs ..."
mkdir -p /opt/x86libs
tar xzf /opt/pack/x86libs.tar.gz -C /opt/x86libs 2>/dev/null || tar xf /opt/pack/x86libs.tar.gz -C /opt/x86libs
find /opt/x86libs -type d -name "box64-x86_64-linux-gnu" | head -1

# --- BDS ---
log "解压 BDS 1.21.90.4 到 /opt/mc1life/bds ..."
mkdir -p /opt/mc1life/bds
unzip -oq /opt/pack/bds-1.21.90.4.zip -d /opt/mc1life/bds
chmod +x /opt/mc1life/bds/bedrock_server

cat > /opt/mc1life/bds/run.sh <<'RUNEOF'
#!/usr/bin/env bash
cd /opt/mc1life/bds
export BOX64_NOBANNER=1
export BOX64_DYNAREC_BIGBLOCK=1
export BOX64_DYNAREC_SAFEFLAGS=0
X86LIB="$(find /opt/x86libs -type d -name 'box64-x86_64-linux-gnu' 2>/dev/null | head -1)"
export BOX64_LD_LIBRARY_PATH="/usr/lib/x86_64-linux-gnu:${X86LIB}"
echo "BOX64_LD_LIBRARY_PATH=${BOX64_LD_LIBRARY_PATH}"
exec box64 ./bedrock_server "$@"
RUNEOF
chmod +x /opt/mc1life/bds/run.sh

cat > /opt/mc1life/bds/server.properties <<'PROPEOF'
server-name=MC1life
gamemode=survival
difficulty=normal
allow-cheats=false
max-players=8
online-mode=true
white-list=false
server-port=19132
server-portv6=19133
view-distance=12
tick-distance=4
max-threads=0
level-name=Bedrock level
default-player-permission-level=member
enable-rcon=true
rcon-port=25575
rcon-password=${RCON_PASSWORD:-CHANGE_ME_STRONG_PASSWORD}
enable-lan-visibility=true
PROPEOF
echo "BDS 就绪 ✅"

# --- Node.js (linux-arm64 离线包, gzip 格式 tar 内置支持) ---
log "安装 Node.js ..."
NODE_TAR="$(ls /opt/pack/node-*-linux-arm64.tar.gz | head -1)"
tar xzf "${NODE_TAR}" -C /opt
NODE_DIR="$(echo "${NODE_TAR}" | sed 's#/opt/pack/##; s#\.tar\.gz$##')"
ln -sfn "/opt/${NODE_DIR}" /opt/node
/opt/node/bin/node --version

# --- Agent (v2 完整包, 含真实凭证 config.json) ---
log "安装 MC1life Agent ..."
mkdir -p /opt/mc1life/agent
tar xzf /opt/pack/mc1life-agent.tar.gz -C /opt/mc1life/agent
[ -f /opt/mc1life/agent/config.json ] || cp /opt/mc1life/agent/config.json.example /opt/mc1life/agent/config.json
cat > /opt/mc1life/start_agent.sh <<'AGEOF'
#!/usr/bin/env bash
cd /opt/mc1life/agent
export PATH=/opt/node/bin:$PATH
nohup node src/index.js >> /opt/mc1life/agent.log 2>&1 &
echo "Agent PID: $!"
AGEOF
chmod +x /opt/mc1life/start_agent.sh
echo "Agent 就绪 ✅"

echo "INSTALL_INNER_DONE"
INNER_EOF
# 注入 AGENT_ONLY (heredoc 带引号不展开变量, 需生成后替换)
sed -i "s/__AGENT_ONLY__/${AGENT_ONLY}/g" "${SCRIPT_DIR}/install_inner.sh"
chmod +x "${SCRIPT_DIR}/install_inner.sh"
log "内部安装脚本就绪, 开始在容器内执行..."
log "命令: proot-distro login --bind ${SCRIPT_DIR}:/opt/pack ${DISTRO} -- bash /opt/pack/install_inner.sh"

if [ "${AGENT_ONLY}" = "1" ]; then
  log "(Agent 更新模式: 跳过 box64/库/BDS/Node 安装)"
fi

if timeout 900 proot-distro login --bind "${SCRIPT_DIR}:/opt/pack" "${DISTRO}" -- bash /opt/pack/install_inner.sh 2>&1; then
  log "内部安装完成 ✅"
else
  fail "内部安装失败 (见上方输出)。请把完整输出发给我"
fi

if [ "${AGENT_ONLY}" = "1" ]; then
  echo
  log "════════════════════════════════════════════════════"
  log " ✅ Agent 已升级到 v2 (极限模式 + 面板网页上传存档)"
  log ""
  log " ▶ 面板: https://mc1life-panel.pages.dev"
  log "    管理员密码: 部署时设置的 PANEL_AUTH_TOKEN"
  log "    访客密码:   部署时设置的 PANEL_VIEWER_TOKEN"
  log "════════════════════════════════════════════════════"
  exit 0
fi

show_usage "${DISTRO}"
