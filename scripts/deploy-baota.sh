#!/usr/bin/env bash
set -euo pipefail

# 宝塔部署脚本：用于已经部署过一版后的“更新部署”。
# 默认项目目录按服务器实际路径 /www/snt-zxzsk；如需临时覆盖，可执行：
#   PROJECT_DIR=/www/other-path PM2_NAME=other-name bash scripts/deploy-baota.sh

PROJECT_DIR="${PROJECT_DIR:-/www/snt-zxzsk}"
WEB_DIR="$PROJECT_DIR/apps/web"
PM2_NAME="${PM2_NAME:-snt-zxzsk-web}"
# PSQL_BIN 允许临时指定 psql 路径，例如：
#   PSQL_BIN=/www/server/pgsql/bin/psql bash scripts/deploy-baota.sh
# 宝塔安装 PostgreSQL 时，psql 不一定在系统 PATH 里，所以脚本会额外扫描常见安装目录。
PSQL_BIN="${PSQL_BIN:-}"

ensure_psql_client() {
  # 数据库建表和验证都依赖 PostgreSQL 客户端 psql。
  # 这里不要求服务器必须安装完整 PostgreSQL 服务，只需要能执行 psql 命令即可。
  if [ -n "$PSQL_BIN" ] && [ -x "$PSQL_BIN" ]; then
    echo "$PSQL_BIN"
    return 0
  fi

  if command -v psql >/dev/null 2>&1; then
    command -v psql
    return 0
  fi

  # 宝塔 PostgreSQL 插件常见路径；如果插件已装但 PATH 没配，这里可以直接复用。
  for candidate in \
    /www/server/pgsql/bin/psql \
    /www/server/postgresql/bin/psql \
    /usr/pgsql-16/bin/psql \
    /usr/pgsql-15/bin/psql \
    /usr/pgsql-14/bin/psql \
    /usr/bin/psql; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done

  echo "psql command not found." >&2
  echo "Please install PostgreSQL client first, then rerun this script." >&2
  echo "" >&2
  echo "Alibaba/CentOS/RHEL usually:" >&2
  echo "  yum install -y postgresql" >&2
  echo "or:" >&2
  echo "  dnf install -y postgresql" >&2
  echo "" >&2
  echo "If PostgreSQL was installed by BaoTa, try:" >&2
  echo "  PSQL_BIN=/www/server/pgsql/bin/psql bash scripts/deploy-baota.sh" >&2
  return 1
}

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

# 先定位 psql，避免服务器未安装客户端时直接报 command not found。
PSQL_CMD="$(ensure_psql_client)"
echo "Using psql: $PSQL_CMD"

# 两个 SQL 都使用 create table if not exists / create index if not exists，可重复执行，不会清空已有数据。
"$PSQL_CMD" "$DATABASE_URL" -f "$PROJECT_DIR/infra/postgres/schema.sql"
"$PSQL_CMD" "$DATABASE_URL" -f "$PROJECT_DIR/infra/postgres/design-render-schema.sql"

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
"$PSQL_CMD" "$DATABASE_URL" -c "
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name like 'design_%'
order by table_name;
"

echo "=== deploy done ==="
