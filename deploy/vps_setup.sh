#!/usr/bin/env bash
# MC1life - Oracle Cloud 免费 ARM 主机一键部署
# 用法: sudo bash vps_setup.sh <你的域名, 如 mc1life.example.com> <Agent共享密钥>
set -euo pipefail

DOMAIN="${1:?用法: vps_setup.sh <域名> <Agent密钥>}"
AGENT_TOKEN="${2:?用法: vps_setup.sh <域名> <Agent密钥>}"
ARCH="$(uname -m)"
MC1LIFE_DIR="/opt/mc1life"

log()  { echo -e "\e[1;32m[MC1life]\e[0m $*"; }
fail() { echo -e "\e[1;31m[MC1life 错误]\e[0m $*" >&2; exit 1; }

# ---------- 0. 系统准备 ----------
log "更新系统并安装基础依赖 ..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl wget unzip tar jq git ufw >/dev/null

# ---------- 1. Node.js (Agent 运行时) ----------
if ! command -v node >/dev/null 2>&1; then
  log "安装 Node.js 20 LTS ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node.js: $(node --version)"

# ---------- 2. 目录与用户 ----------
id -u mc1life >/dev/null 2>&1 || useradd -m -s /bin/bash mc1life
mkdir -p "${MC1LIFE_DIR}"/{bds,agent,deploy}
chown -R mc1life:mc1life "${MC1LIFE_DIR}"

# ---------- 3. BDS 1.21.90.4 ----------
if [ ! -f "${MC1LIFE_DIR}/bds/bedrock_server" ]; then
  log "安装 BDS 1.21.90.4 (ARM 将自动装 box64) ..."
  bash /workspace/mc1life/bds/install.sh "${MC1LIFE_DIR}/bds"
else
  log "BDS 已存在, 跳过"
fi

# ---------- 4. Agent ----------
log "部署 Agent ..."
cp -r /workspace/mc1life/agent/* "${MC1LIFE_DIR}/agent/" 2>/dev/null || true
cd "${MC1LIFE_DIR}/agent"
[ -f config.json ] || cp config.json.example config.json

# 写入实际配置
python3 - "${MC1LIFE_DIR}/agent/config.json" "${DOMAIN}" "${AGENT_TOKEN}" <<'PYEOF'
import json, sys
p, domain, token = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(p))
cfg["workerUrl"] = f"wss://api.{domain}/ws/agent"
cfg["token"] = token
json.dump(cfg, open(p, "w"), indent=2, ensure_ascii=False)
PYEOF

log "安装 Agent 依赖 (npm install) ..."
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

# ---------- 5. systemd ----------
log "安装 systemd 服务 ..."
install -o mc1life -g mc1life -m 644 /workspace/mc1life/bds/mc1life-bds.service /etc/systemd/system/
install -o mc1life -g mc1life -m 644 /workspace/mc1life/agent/mc1life-agent.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable mc1life-bds mc1life-agent

# ---------- 6. 防火墙 (仅放行游戏端口, 管理走 Agent 出站 WS 连接, 无需隧道) ----------
log "配置防火墙 (UFW: 放行 19132/udp, 拒绝其余) ..."
ufw allow 19132/udp >/dev/null 2>&1 || true
ufw allow 22/tcp >/dev/null 2>&1 || true
echo "y" | ufw enable >/dev/null 2>&1 || true

echo
log "================================================================"
log "VPS 端部署完成! 后续步骤:"
log " 1. 启动 BDS:  systemctl start mc1life-bds   (首次生成配置)"
log " 2. 启动 Agent: systemctl start mc1life-agent (出站 WS 连 Worker, 无需隧道)"
log " 3. 在 Cloudflare 侧创建资源并发布 Worker+面板 (见 deploy/cf_publish.sh)"
log "================================================================"
