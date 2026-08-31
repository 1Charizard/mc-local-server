#!/usr/bin/env bash
set -euo pipefail
export PATH=/opt/node20v/bin:$PATH
cd "$(dirname "$0")/.."
node test/harness.js 8794 > /tmp/mc1life_auth.log 2>&1 &
HP=$!
sleep 2
PASS=1
echo "--- 无 token (期望 401) ---"
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8794/api/status)
echo "HTTP:$CODE"; [ "$CODE" = "401" ] || PASS=0
echo "--- 带正确 token (期望 503 Agent离线) ---"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${PANEL_AUTH_TOKEN}" http://127.0.0.1:8794/api/status)
echo "HTTP:$CODE"; [ "$CODE" = "503" ] || PASS=0
echo "--- 带错误 token (期望 401) ---"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong-token" http://127.0.0.1:8794/api/status)
echo "HTTP:$CODE"; [ "$CODE" = "401" ] || PASS=0
kill $HP 2>/dev/null || true
[ "$PASS" = "1" ] && echo "==> ✅ 鉴权测试通过" || { echo "==> ❌ 鉴权测试失败"; cat /tmp/mc1life_auth.log | tail -5; exit 1; }
