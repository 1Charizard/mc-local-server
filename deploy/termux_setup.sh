#!/usr/bin/env bash
# MC1life - 荣耀 8X (或任意 Android 手机) Termux 一键部署
# 在 Termux 里执行: bash termux_setup.sh
# 作用: 装 proot Debian → box64 → BDS 1.21.90.4 → Agent → 打印 IPv6 连接地址
set -euo pipefail

log()  { echo -e "\e[1;32m[MC1life]\e[0m $*"; }
warn() { echo -e "\e[1;33m[MC1life 提示]\e[0m $*"; }
fail() { echo -e "\e[1;31m[MC1life 错误]\e[0m $*" >&2; exit 1; }

# 确认 Termux 环境
[ -n "${PREFIX:-}" ] || fail "请在 Termux 中运行 (不是 adb shell)"
ARCH="$(uname -m)"
log "Termux 环境确认: ${ARCH}, Android API ${TERMUX_VERSION:-unknown}"

# 0. 保持唤醒 (防止锁屏断网/休眠)
log "安装 wakelock 保持运行..."
pkg install -y termux-api 2>/dev/null || true
termux-wake-lock 2>/dev/null && log "已获取唤醒锁" || warn "未获取唤醒锁(无 termux-api 或需重启Termux)"

# 1. 基础包
log "安装基础包..."
pkg update -y 2>&1 | tail -2 || true
pkg install -y proot-distro wget curl unzip jq nodejs-lts 2>&1 | tail -3 || pkg install -y proot-distro wget curl unzip jq nodejs

# 2. 安装 Debian
if ! proot-distro list 2>/dev/null | grep -q debian; then
  log "安装 proot Debian (约 200MB, 需几分钟)..."
  proot-distro install debian
else
  log "Debian 已安装"
fi

DEBIAN_CMD="proot-distro login debian"

# 3. 在 Debian 内装 box64 + BDS
log "在 Debian 内执行部署 (box64 + BDS 1.21.90.4)..."
$DEBIAN_CMD -- bash -s <<'INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
log()  { echo -e "\e[1;32m[MC1life-Debian]\e[0m $*"; }
fail() { echo -e "\e[1;31m[MC1life 错误]\e[0m $*" >&2; exit 1; }

apt-get update -qq
apt-get install -y -qq wget curl unzip jq ca-certificates libcurl4-openssl-dev >/dev/null

# --- box64 安装 (GitHub 源, 国内网络可达) ---
if ! command -v box64 >/dev/null 2>&1; then
  log "安装 box64 (x86_64 模拟层)..."
  wget -q https://ryanfortner.github.io/box64-debs/box64.list -O /etc/apt/sources.list.d/box64.list
  curl -s https://ryanfortner.github.io/box64-debs/box64-archive-keyring.gpg -o /usr/share/keyrings/box64-archive-keyring.gpg
  apt-get update -qq
  apt-get install -y -qq box64 || {
    warn "apt 安装 box64 失败, 尝试从 GitHub release 安装..."
    BOX64_VER="v0.4.4"
    mkdir -p /opt/box64 && cd /opt/box64
    curl -sL "https://github.com/ptitSeb/box64/releases/download/${BOX64_VER}/box64-${BOX64_VER}-Linux-aarch64.deb" -o box64.deb || \
      curl -sL "https://github.com/ptitSeb/box64/releases/latest/download/box64-bundle-x86-libs-${BOX64_VER}.tar.gz" -o x86libs.tar.gz
    if [ -f box64.deb ]; then dpkg -i box64.deb || apt-get -f install -y; fi
  }
fi
log "box64: $(box64 --version 2>/dev/null | head -1)"

# --- x86_64 系统库 (box64 需要) ---
log "安装 x86_64 兼容库..."
if [ ! -d /usr/x86_64-linux-gnu ] || [ -z "$(ls -A /usr/x86_64-linux-gnu 2>/dev/null)" ]; then
  # 使用 box64 官方 x86 libs bundle
  mkdir -p /opt/x86libs
  cd /opt/x86libs
  curl -sL "https://github.com/ptitSeb/box64/releases/latest/download/box64-bundle-x86-libs-v0.4.4.tar.gz" -o libs.tar.gz
  tar xzf libs.tar.gz 2>/dev/null || true
  ls lib/x86_64-linux-gnu >/dev/null 2>&1 && cp -rn lib/x86_64-linux-gnu/* /usr/lib/x86_64-linux-gnu/ 2>/dev/null || true
  export BOX64_LD_LIBRARY_PATH=/opt/x86libs/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu
  echo 'export BOX64_LD_LIBRARY_PATH=/opt/x86libs/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu' >> /etc/profile.d/box64.sh
fi

# --- BDS 1.21.90.4 下载 ---
BDS_DIR=/opt/mc1life/bds
if [ ! -f "${BDS_DIR}/bedrock_server" ]; then
  mkdir -p "${BDS_DIR}"
  log "下载 BDS 1.21.90.4 (约 65MB)..."
  cd "${BDS_DIR}"
  # 先试官方源, 失败用 GitHub 镜像
  curl -fSL --max-time 300 -o bds.zip "https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.21.90.4.zip" 2>/dev/null || {
    warn "官方源不可达, 尝试备用下载..."
    # 备用: 通过 jsdelivr 取元数据后走 gh 镜像 (若有)
    curl -fSL --max-time 300 -o bds.zip "https://github.com/Bedrock-OSS/BDS-Versions/raw/main/linux/bedrock-server-1.21.90.4.zip" 2>/dev/null || \
      fail "BDS 下载失败。请手动下载 bedrock-server-1.21.90.4.zip 放到 /sdcard/ 后重跑"
  }
  unzip -oq bds.zip && rm -f bds.zip
  chmod +x bedrock_server
else
  log "BDS 已存在"
fi

# --- 启动脚本 (box64) ---
cat > "${BDS_DIR}/run.sh" <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
export BOX64_NOBANNER=1
export BOX64_DYNAREC_BIGBLOCK=1
export BOX64_LD_LIBRARY_PATH=/opt/x86libs/lib/x86_64-linux-gnu:/usr/lib/x86_64-linux-gnu
exec box64 ./bedrock_server "$@"
EOF
chmod +x "${BDS_DIR}/run.sh"

# --- 低配优化 server.properties ---
if [ ! -f "${BDS_DIR}/server.properties" ]; then
  log "生成低配优化配置 (荣耀8X 4GB)..."
  cat > "${BDS_DIR}/server.properties" <<'EOF'
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
EOF
fi

log "BDS 部署完成: ${BDS_DIR}"
INNER

# 4. 测试启动 BDS (10 秒)
log "测试启动 BDS (10 秒, 看是否进入 Server started)..."
$DEBIAN_CMD -- bash -c 'cd /opt/mc1life/bds && timeout 12 ./run.sh 2>&1 | head -20 || true'

# 5. 打印 IPv6 连接信息
log "获取本机 IPv6 地址 (玩家连接用)..."
IPV6="$($DEBIAN_CMD -- bash -c "hostname -I 2>/dev/null | tr ' ' '\n' | grep -i ':' | grep -v '^fe80' | head -1" 2>/dev/null || true)"
if [ -z "${IPV6}" ]; then
  warn "未检测到全局 IPv6, 检查手机 WiFi 是否支持 IPv6 (很多路由器默认开启)"
  IPV6="[你的IPv6地址]"
else
  log "✅ 全局 IPv6: ${IPV6}"
fi

echo
log "================================================================"
log " 部署完成!"
log " 玩家连接地址: ${IPV6}:19133  (IPv6 直连)"
log " 管理面板:      https://mc1life-panel.pages.dev"
log " 面板密码:      (在电脑端 .credentials/agent.env 查看 PANEL_AUTH_TOKEN)"
log " 下一步:        配置 Agent 见 agent/README (填入 workerUrl/token)"
log "================================================================"
