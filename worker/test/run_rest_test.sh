#!/usr/bin/env bash
# Worker REST 验证
set -euo pipefail
export PATH=/opt/node20v/bin:$PATH
cd "$(dirname "$0")/.."

echo "==> 启动 harness (:8790)"
node test/harness.js 8790 > /tmp/mc1life_harness.log 2>&1 &
HARNESS_PID=$!
sleep 2

PASS=1
check() { # desc expected_code actual_code
  if [ "$2" = "$3" ]; then echo "✅ $1 -> $3"; else echo "❌ $1 -> 期望 $2 实际 $3"; PASS=0; fi
}

echo "==> 测试 REST 路由"
check "GET / 健康检查" 200 "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/)"
check "GET /api/status (Agent 离线应 503)" 503 "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/api/status)"
check "GET /api/unknown (404)" 404 "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/api/unknown)"
check "POST /api/cmd 缺参数 (应 400/200 且返回 ok:false)" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8790/api/cmd)"
check "GET /ws/agent 无 token (401)" 401 "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/ws/agent)"
check "GET /ws/agent 无 Upgrade (426)" 426 "$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8790/ws/agent?agent=mc1life-test&token=test-token')"

echo "==> 校验响应内容"
BODY="$(curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8790/api/cmd)"
echo "$BODY" | grep -q '"ok":false' && echo "✅ /api/cmd 缺参返回 ok:false" || { echo "❌ /api/cmd 响应异常: $BODY"; PASS=0; }

kill $HARNESS_PID 2>/dev/null || true
if [ "$PASS" = "1" ]; then echo "==> ✅ Worker REST 验证通过"; exit 0; else echo "==> ❌ 验证失败"; exit 1; fi
