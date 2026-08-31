#!/usr/bin/env bash
# MC1life - Cloudflare 侧资源创建与发布脚本
# 前置: 已 wrangler login (或在 .wrangler 缓存中有账号); node >= 20
# 用法: bash cf_publish.sh <域名,如 mc1life.example.com> <R2访问密钥ID> <R2访问密钥>
#   R2 密钥在 Cloudflare 控制台 -> R2 -> 管理 API 令牌 创建
set -euo pipefail

DOMAIN="${1:?用法: cf_publish.sh <域名> <R2_key_id> <R2_secret>}"
R2_KEY="${2:?}"
R2_SECRET="${3:?}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/node20v/bin:/usr/local/bin:$PATH"

log()  { echo -e "\e[1;32m[CF]\e[0m $*"; }
fail() { echo -e "\e[1;31m[CF 错误]\e[0m $*" >&2; exit 1; }

ACCOUNT_ID="$(cat "${ROOT}/../.wrangler/cache/pages.json" 2>/dev/null | jq -r .account_id 2>/dev/null || echo '')"
[ -n "${ACCOUNT_ID}" ] || ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
[ -n "${ACCOUNT_ID}" ] || fail "无法确定 Cloudflare Account ID (设置 CLOUDFLARE_ACCOUNT_ID 或检查 .wrangler/cache/pages.json)"

cd "${ROOT}/worker"

# ---------- 1. R2 Bucket ----------
log "创建 R2 bucket mc1life-backups ..."
wrangler r2 bucket create mc1life-backups 2>/dev/null || log "  (bucket 已存在或需在控制台创建)"

# ---------- 2. D1 数据库 ----------
log "创建 D1 数据库 mc1life ..."
D1_OUT="$(wrangler d1 create mc1life 2>&1 || true)"
echo "${D1_OUT}"
D1_ID="$(echo "${D1_OUT}" | grep -oE 'database_id = "[a-f0-9-]+"' | head -1 | grep -oE '[a-f0-9-]{36}' || echo 'REPLACE_WITH_D1_DATABASE_ID')"

# ---------- 3. KV Namespace ----------
log "创建 KV namespace sessions ..."
KV_OUT="$(wrangler kv namespace create SESSION_KV 2>&1 || true)"
echo "${KV_OUT}"
KV_ID="$(echo "${KV_OUT}" | grep -oE 'id = "[a-f0-9-]+"' | head -1 | grep -oE '[a-f0-9-]{36}' || echo 'REPLACE_WITH_KV_NAMESPACE_ID')"

# ---------- 4. 生成 wrangler.toml ----------
log "生成 wrangler.toml ..."
cat > wrangler.toml <<EOF
name = "mc1life-api"
main = "src/index.js"
compatibility_date = "2024-06-01"

[vars]
AGENT_TOKEN = "mc1life-shared-secret-change-me"
PANEL_JWT_SECRET = "mc1life-jwt-secret-change-me"
ALLOWED_AGENT_ID = "mc1life"

[[r2_buckets]]
binding = "BACKUP_BUCKET"
bucket_name = "mc1life-backups"

[[kv_namespaces]]
binding = "SESSION_KV"
id = "${KV_ID}"

[[d1_databases]]
binding = "DB"
database_name = "mc1life"
database_id = "${D1_ID}"

routes = [
  { pattern = "api.${DOMAIN}", custom_domain = false }
]
EOF

# ---------- 5. 初始化 D1 schema ----------
log "初始化 D1 表结构 ..."
wrangler d1 execute mc1life --file=./schema.sql --remote

# ---------- 6. 部署 Worker ----------
log "安装 Worker 依赖并部署 ..."
npm install --no-audit --no-fund 2>&1 | tail -2
wrangler deploy

# ---------- 7. 部署面板到 Pages ----------
log "构建并部署面板到 Cloudflare Pages ..."
cd "${ROOT}/panel"
npm install --no-audit --no-fund 2>&1 | tail -2
npm run build
wrangler pages deploy dist --project-name mc1life-panel

# ---------- 8. 绑定自定义域名 (需域名已在 CF 控制) ----------
log "创建 Pages 自定义域名 ..."
wrangler pages project list 2>/dev/null | grep -q mc1life-panel || \
  wrangler pages project create mc1life-panel --production-branch main 2>/dev/null || true

echo
log "================================================================"
log "Cloudflare 侧部署完成!"
log "  面板:  https://mc1life-panel.pages.dev  (或绑定 panel.${DOMAIN})"
log "  API:   https://api.${DOMAIN}"
log "  Agent: wss://api.${DOMAIN}/ws/agent"
log "  请在 CF 控制台设置 secrets:"
log "    wrangler secret put AGENT_TOKEN --name mc1life-api"
log "    wrangler secret put PANEL_JWT_SECRET --name mc1life-api"
log "  R2 密钥请填入 agent/config.json 的 r2 段"
log "================================================================"
