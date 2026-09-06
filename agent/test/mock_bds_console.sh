#!/usr/bin/env bash
# mock BDS (真实行为): 管道 stdin 下 BDS 不回显命令, 只输出带时间戳的响应行
# say/kick 等命令成功时控制台静默 (无输出)
echo "[INFO] Starting Server..."
sleep 1
echo "[INFO] Version: 1.21.90.4"
sleep 1
echo "[INFO] Server started."
while IFS= read -r cmd; do
  case "$cmd" in
    list) echo "[2026-08-30 19:00:00:000 INFO] There are 2/10 players online: Steve, Alex" ;;
    say*) : ;;  # 无输出命令
    stop) echo "[2026-08-30 19:00:00:000 INFO] Server stop requested."; echo "[2026-08-30 19:00:00:100 INFO] Quit correctly"; exit 0 ;;
    *) echo "[2026-08-30 19:00:00:000 INFO] Unknown command: $cmd" ;;
  esac
done
