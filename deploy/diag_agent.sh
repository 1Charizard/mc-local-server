#!/usr/bin/env bash
# MC1life - 网络诊断 (宿主 Termux 运行; 容器内操作全走 heredoc, 避免 pkill 自杀)
# 用法: AGENT_TOKEN=<你的Agent令牌> bash diag_agent.sh
# 令牌从环境变量读取, 不硬编码在脚本里
set -uo pipefail
[ -n "${AGENT_TOKEN:-}" ] || { echo "[MC1life 错误] 请先设置 AGENT_TOKEN 环境变量 (如: AGENT_TOKEN=xxx bash diag_agent.sh)" >&2; exit 1; }
log()  { echo -e "\e[1;32m[MC1life]\e[0m $*"; }
fail() { echo -e "\e[1;31m[MC1life 错误]\e[0m $*" >&2; exit 1; }

# 找容器
DISTRO=""
for c in debian-trixie-aarch64 debian-trixie debian; do
  if timeout 30 proot-distro login "$c" -- true >/dev/null 2>&1; then DISTRO="$c"; break; fi
done
[ -n "$DISTRO" ] || fail "未找到 Debian 容器"
log "容器: ${DISTRO}"

log "容器内诊断 (停残留进程 -> 测网络) ..."
AGENT_TOKEN="$AGENT_TOKEN" timeout 120 proot-distro login "$DISTRO" -- bash -s <<'INNER'
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
log() { echo -e "\e[1;34m[MC1life-Debian]\e[0m $*"; }

log "=== 1. 停残留进程 ==="
pkill -f "node src/index.js" 2>/dev/null || true
pkill -f "bedrock_server" 2>/dev/null || true
sleep 1
ps aux 2>/dev/null | grep -E "node|bedrock" | grep -v grep || echo "(无 node/bedrock 进程)"

log "=== 2. node 版本 ==="
/opt/node/bin/node --version

log "=== 3. 测 pages.dev HTTPS (20s 超时) ==="
timeout 25 /opt/node/bin/node -e 'const https=require("https");const t=Date.now();https.get("https://mc1life-panel.pages.dev/api/status",r=>{console.log("HTTP",r.statusCode,"耗时",Date.now()-t+"ms");r.resume()}).on("error",e=>console.log("ERR",e.code,e.message))'

log "=== 4. 测 DNS 解析 ==="
timeout 15 /opt/node/bin/node -e 'const dns=require("dns");dns.lookup("mc1life-panel.pages.dev",(e,a)=>console.log(e?"DNS ERR "+e.code:"DNS OK "+a))'

log "=== 5. 测 raw 网络 (443) ==="
timeout 15 /opt/node/bin/node -e 'const net=require("net");const t=Date.now();const s=net.connect(443,"mc1life-panel.pages.dev",()=>{console.log("TCP 443 OK 耗时",Date.now()-t+"ms");s.end()});s.on("error",e=>console.log("TCP ERR",e.code))'

log "=== 6. 测 workerUrl 的 /api/agent/heartbeat 端点 ==="
timeout 25 /opt/node/bin/node -e 'const https=require("https");const u="https://mc1life-panel.pages.dev/api/agent/heartbeat?agent=mc1life&token=${AGENT_TOKEN}";const data=JSON.stringify({status:{agentId:"mc1life",running:false},logs:["[diag] test"]});const req=https.request(u,{method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(data)}},r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>console.log("heartbeat HTTP",r.statusCode,b.slice(0,150)))});req.on("error",e=>console.log("heartbeat ERR",e.code,e.message));req.write(data);req.end()'

echo "DIAG_DONE"
INNER
log "诊断完成"
