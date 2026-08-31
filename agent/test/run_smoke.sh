#!/usr/bin/env bash
# MC1life Agent 冒烟测试:
#  1. 起 mock RCON 服务器 (25575)
#  2. 起 mock Worker (8787)
#  3. 生成临时 config.json (指向 mock)
#  4. 启动 Agent, 验证: 连上 Worker / 自动拉起 mock BDS / 状态上报 / 日志上报
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1. 启动 mock RCON (:25575)"
node test/mock_rcon_server.js 25575 testpass > /tmp/mc1life_test_rcon.log 2>&1 &
RCON_PID=$!
sleep 0.5

echo "==> 2. 启动 mock Worker (:8787)"
node test/mock_worker.js 8787 > /tmp/mc1life_test_worker.log 2>&1 &
WORKER_PID=$!
sleep 0.5

echo "==> 3. 生成测试 config.json"
chmod +x test/mock_bds.sh
cat > /tmp/mc1life_test_config.json <<'EOF'
{
  "workerUrl": "ws://127.0.0.1:8787/ws/agent",
  "token": "test-token",
  "agentId": "mc1life-test",
  "bds": {
    "dir": "/workspace/mc1life/agent/test",
    "runScript": "/workspace/mc1life/agent/test/mock_bds.sh",
    "worldDir": "/tmp/mc1life_test_worlds",
    "startTimeoutMs": 20000
  },
  "rcon": { "host": "127.0.0.1", "port": 25575, "password": "testpass" },
  "r2": { "endpoint": "http://127.0.0.1:9999", "accessKeyId": "x", "secretAccessKey": "y", "bucket": "nope" },
  "backup": { "auto": false }
}
EOF
mkdir -p /tmp/mc1life_test_worlds

echo "==> 4. 启动 Agent (10s 观察)"
MC1LIFE_CONFIG=/tmp/mc1life_test_config.json node src/index.js > /tmp/mc1life_test_agent.log 2>&1 &
AGENT_PID=$!

sleep 10

echo "==> 5. 检查结果"
echo "--- Agent 自身日志 ---"
cat /tmp/mc1life_test_agent.log
echo "--- Mock Worker 收到的消息 ---"
cat /tmp/mc1life_test_worker.log

PASS=1
grep -q "Worker 连接已建立" /tmp/mc1life_test_agent.log || { echo "FAIL: Agent 未连上 Worker"; PASS=0; }
grep -q "自动启动" /tmp/mc1life_test_agent.log || { echo "FAIL: Agent 未自动拉起 BDS"; PASS=0; }
grep -q "hello" /tmp/mc1life_test_worker.log || { echo "FAIL: Worker 未收到 hello"; PASS=0; }
grep -q '"running":true' /tmp/mc1life_test_worker.log || { echo "FAIL: 状态上报 running!=true"; PASS=0; }
grep -q '"players":\["alex","steve"\]' /tmp/mc1life_test_worker.log || { echo "FAIL: RCON 玩家列表解析失败"; PASS=0; }
grep -q "log lines" /tmp/mc1life_test_worker.log || { echo "FAIL: 日志未上报"; PASS=0; }

kill $AGENT_PID $WORKER_PID $RCON_PID 2>/dev/null || true
if [ "$PASS" = "1" ]; then
  echo "==> ✅ 冒烟测试通过"
  exit 0
else
  echo "==> ❌ 冒烟测试失败"
  exit 1
fi
