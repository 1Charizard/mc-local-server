#!/usr/bin/env bash
# 模拟 BDS: 打印启动日志后持续运行 (供本地冒烟测试)
echo "[INFO] Starting Server..."
sleep 1
echo "[INFO] Version 1.21.90.4"
sleep 1
echo "[INFO] Server started."
while true; do
  sleep 1
done
