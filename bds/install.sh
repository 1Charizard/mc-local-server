#!/usr/bin/env bash
# MC1life - BDS 1.21.90.4 安装脚本
# 支持: x86_64 原生 | aarch64 (Oracle ARM) 通过 box64 模拟
# 用法: sudo bash install.sh [安装目录]
set -euo pipefail

BDS_VERSION="1.21.90.4"
BDS_URL="https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${BDS_VERSION}.zip"
INSTALL_DIR="${1:-/opt/mc1life/bds}"
ARCH="$(uname -m)"

log()  { echo -e "\e[1;32m[MC1life]\e[0m $*"; }
fail() { echo -e "\e[1;31m[MC1life 错误]\e[0m $*" >&2; exit 1; }

log "BDS ${BDS_VERSION} 安装到 ${INSTALL_DIR} (arch=${ARCH})"

# 0. 基础依赖
log "安装基础依赖 unzip curl ..."
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq unzip curl jq tar >/dev/null
fi

# 1. ARM 处理: BDS 官方仅提供 x86_64 二进制, ARM 需 box64
if [ "${ARCH}" = "aarch64" ] || [ "${ARCH}" = "arm64" ]; then
  log "检测到 ARM 架构, 安装 box64 (x86_64 模拟层)"
  if ! command -v box64 >/dev/null 2>&1; then
    wget -q https://ryanfortner.github.io/box64-debs/box64.list -O /etc/apt/sources.list.d/box64.list || \
      curl -s https://ryanfortner.github.io/box64-debs/box64.list -o /etc/apt/sources.list.d/box64.list
    if [ -f /etc/apt/sources.list.d/box64.list ]; then
      sed -i 's|deb \[signed-by=/usr/share/keyrings/box64-archive-keyring.gpg\] https://ryanfortner.github.io/box64-debs/ ./|deb [signed-by=/usr/share/keyrings/box64-archive-keyring.gpg] https://ryanfortner.github.io/box64-debs/ ./|' /etc/apt/sources.list.d/box64.list
    fi
    curl -s https://ryanfortner.github.io/box64-debs/box64-archive-keyring.gpg -o /usr/share/keyrings/box64-archive-keyring.gpg || true
    apt-get update -qq && apt-get install -y -qq box64 || fail "box64 安装失败, 请手动安装 box64 后重试"
  fi
  log "box64 已就绪: $(box64 --version 2>/dev/null | head -1)"
fi

# 2. 下载 BDS
mkdir -p "${INSTALL_DIR}"
if [ ! -f "${INSTALL_DIR}/bedrock_server" ]; then
  log "下载 BDS ${BDS_VERSION} (约 80MB) ..."
  TMP_ZIP="$(mktemp --suffix=.zip)"
  curl -fsSL -o "${TMP_ZIP}" "${BDS_URL}" || fail "下载失败: ${BDS_URL}\n 提示: 若网络受限可手动下载后放入 ${INSTALL_DIR} 并解压"
  log "解压中 ..."
  unzip -oq "${TMP_ZIP}" -d "${INSTALL_DIR}"
  rm -f "${TMP_ZIP}"
  chmod +x "${INSTALL_DIR}/bedrock_server"
else
  log "检测到已存在 bedrock_server, 跳过下载"
fi

# 3. 生成运行包装脚本 (适配 box64)
if [ "${ARCH}" = "aarch64" ] || [ "${ARCH}" = "arm64" ]; then
  cat > "${INSTALL_DIR}/run.sh" <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
export BOX64_NOBANNER=1
export BOX64_DYNAREC_BIGBLOCK=1
exec box64 ./bedrock_server "$@"
EOF
else
  cat > "${INSTALL_DIR}/run.sh" <<'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")"
exec ./bedrock_server "$@"
EOF
fi
chmod +x "${INSTALL_DIR}/run.sh"

# 4. 目录准备
mkdir -p "${INSTALL_DIR}/worlds" "${INSTALL_DIR}/behavior_packs" "${INSTALL_DIR}/resource_packs"

log "安装完成:"
log "  运行: ${INSTALL_DIR}/run.sh (需在 ${INSTALL_DIR} 目录内)"
log "  注意: 首次运行会生成 server.properties / whitelist.json 等配置"
log "  端口: 19132/udp (游戏)  19132/tcp(IPv6可关)  25575/tcp (RCON, 默认关)"
