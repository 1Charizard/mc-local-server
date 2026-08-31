#!/usr/bin/env bash
# MC1life - 行为包/资源包部署脚本
# 将源目录(如 /workspace/mcpack_work/merged_dir) 部署到 BDS 的 behavior_packs/
# 用法: bash deploy_packs.sh <BDS目录> <源目录...>
set -euo pipefail

BDS_DIR="${1:?用法: deploy_packs.sh <BDS目录> <源目录...>}"
shift

log() { echo -e "\e[1;34m[MC1life]\e[0m $*"; }

# 检查源目录是否为有效行为包 (含 manifest.json)
check_pack() {
  local src="$1"
  [ -f "${src}/manifest.json" ] || { echo "警告: ${src} 缺少 manifest.json, 跳过"; return 1; }
  local type
  type="$(jq -r '.modules[0].type // empty' "${src}/manifest.json" 2>/dev/null || true)"
  [ -n "${type}" ] || type="data"
  echo "${type}"
}

declare -a BEHAVIOR_PACKS=()
declare -a RESOURCE_PACKS=()

for src in "$@"; do
  [ -d "${src}" ] || { echo "跳过不存在的目录: ${src}"; continue; }
  type="$(check_pack "${src}")" || continue
  uuid="$(jq -r '.header.uuid // empty' "${src}/manifest.json" 2>/dev/null || true)"
  name="$(jq -r '.header.name // "unnamed"' "${src}/manifest.json" 2>/dev/null || true)"
  dest_name="${uuid:-${name//[^a-zA-Z0-9_-]/_}}"
  if [ "${type}" = "data" ]; then
    mkdir -p "${BDS_DIR}/behavior_packs/${dest_name}"
    cp -r "${src}/." "${BDS_DIR}/behavior_packs/${dest_name}/"
    BEHAVIOR_PACKS+=("${dest_name}")
    log "行为包已部署: ${name} -> behavior_packs/${dest_name}"
  else
    mkdir -p "${BDS_DIR}/resource_packs/${dest_name}"
    cp -r "${src}/." "${BDS_DIR}/resource_packs/${dest_name}/"
    RESOURCE_PACKS+=("${dest_name}")
    log "资源包已部署: ${name} -> resource_packs/${dest_name}"
  fi
done

# 生成 world 级 world_behavior_packs.json (如 world 已存在)
WORLD_DIR="${BDS_DIR}/worlds/$(jq -r '.level-name // "Bedrock level"' "${BDS_DIR}/server.properties" 2>/dev/null | tr -d '\r' || echo 'Bedrock level')"
if [ -d "${WORLD_DIR}" ]; then
  if [ ${#BEHAVIOR_PACKS[@]} -gt 0 ]; then
    jq -n '[range(0;'"${#BEHAVIOR_PACKS[@]}"') as $i | {pack_id: $ARGS.posix[0][$i].uuid, version: $ARGS.posix[0][$i].version}]' \
      --jsonargs "$(for p in "${BEHAVIOR_PACKS[@]}"; do jq -c '{uuid:.header.uuid, version:.header.version}' "${BDS_DIR}/behavior_packs/${p}/manifest.json"; done | tr '\n' ' ')" > /dev/null 2>&1 || true
    # 简化写入: 使用 pack uuid + version
    python3 - "${WORLD_DIR}/world_behavior_packs.json" "${BDS_DIR}/behavior_packs" "${BEHAVIOR_PACKS[@]}" <<'PYEOF'
import json, sys, os
out, packs_dir, *packs = sys.argv[1], sys.argv[2], sys.argv[3:]
entries = []
for p in packs:
    mf = json.load(open(os.path.join(packs_dir, p, "manifest.json")))
    entries.append({"pack_id": mf["header"]["uuid"], "version": mf["header"]["version"]})
json.dump(entries, open(out, "w"), indent=2)
print(f"已写入 {out}: {len(entries)} 个行为包")
PYEOF
  fi
  log "提示: 若世界已存在, 请重启服务器生效; 新世界首次启动自动加载 packs/ 下的包"
else
  log "世界目录尚未生成, 首次启动时 BDS 会自动加载 behavior_packs/ 中的包"
fi

log "部署完成: 行为包 ${#BEHAVIOR_PACKS[@]} 个, 资源包 ${#RESOURCE_PACKS[@]} 个"
