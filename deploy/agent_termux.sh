#!/usr/bin/env bash
# MC1life - 在 Termux 的 Debian 里部署 Agent (手机端)
# 用法: 先把 mc1life 项目放到手机 (如 /sdcard/mc1life), 然后:
#   proot-distro login debian -- bash /sdcard/mc1life/deploy/agent_termux.sh
set -euo pipefail
log() { echo -e "\e[1;32m[MC1life-Agent]\e[0m $*"; }

SRC="/sdcard/mc1life"
AGENT_DIR=/opt/mc1life/agent

log "复制 Agent 到 /opt/mc1life/agent ..."
mkdir -p "${AGENT_DIR}"
cp -r "${SRC}/agent/src" "${SRC}/agent/package.json" "${SRC}/agent/config.json.example" "${AGENT_DIR}/" 2>/dev/null || true
cd "${AGENT_DIR}"

log "安装 Node 依赖 ..."
apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2

log "提示: 请编辑 ${AGENT_DIR}/config.json 填入 workerUrl/token/r2"
log "      (从 config.json.example 复制)  然后运行: cd ${AGENT_DIR} && node src/index.js"
