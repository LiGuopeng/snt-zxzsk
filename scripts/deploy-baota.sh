#!/usr/bin/env bash
set -euo pipefail

# 宝塔部署脚本：用于已经部署过一版后的“更新部署”。
# 默认项目目录按服务器实际路径 /www/snt-zxzsk；如需临时覆盖，可执行：
#   PROJECT_DIR=/www/other-path PM2_NAME=other-name bash scripts/deploy-baota.sh

PROJECT_DIR="${PROJECT_DIR:-/www/snt-zxzsk}"
WEB_DIR="$PROJECT_DIR/apps/web"
PM2_NAME="${PM2_NAME:-snt-zxzsk-web}"

echo "=== 1. check project directory ==="
if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project directory not found: $PROJECT_DIR"
  exit 1
fi

if [ ! -d "$WEB_DIR" ]; then
  echo "Web app directory not found: $WEB_DIR"
  exit 1
fi

cd "$PROJECT_DIR"

echo "=== 2. show git status before pull ==="
git status --short

echo "=== 3. pull latest code ==="
git pull

echo "=== 4. install dependencies ==="
cd "$WEB_DIR"
corepack enable || true
pnpm install

echo "=== 5. read DATABASE_URL from .env.local ==="
if [ ! -f "$WEB_DIR/.env.local" ]; then
  echo "Missing $WEB_DIR/.env.local"
  echo "Please create it before deployment."
  exit 1
fi

# 只读取 DATABASE_URL 这一行，避免把 .env.local 当 shell 脚本 source 后执行到特殊字符。
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$WEB_DIR/.env.local" | tail -n 1 | cut -d '=' -f 2-)"

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is missing in $WEB_DIR/.env.local"
  exit 1
fi

echo "=== 6. ensure database schema ==="
cd "$PROJECT_DIR"

# 两个 SQL 都使用 create table if not exists / create index if not exists，可重复执行，不会清空已有数据。
psql "$DATABASE_URL" -f "$PROJECT_DIR/infra/postgres/schema.sql"
psql "$DATABASE_URL" -f "$PROJECT_DIR/infra/postgres/design-render-schema.sql"

echo "=== 7. build Next.js app ==="
cd "$WEB_DIR"
pnpm build

echo "=== 8. ensure upload directory writable ==="
mkdir -p "$WEB_DIR/public/uploads"
chmod -R 755 "$WEB_DIR/public/uploads"

echo "=== 9. restart pm2 service ==="
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start "pnpm start" --name "$PM2_NAME" --cwd "$WEB_DIR"
fi

pm2 save

echo "=== 10. verify local health endpoint ==="
curl -fsS --max-time 15 http://127.0.0.1:3000/api/health/knowledge
echo

echo "=== 11. verify design tables ==="
psql "$DATABASE_URL" -c "
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name like 'design_%'
order by table_name;
"

echo "=== deploy done ==="
