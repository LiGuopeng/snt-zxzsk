import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

declare global {
  // Next.js 开发模式会频繁热更新模块；把连接池挂到 globalThis 上，避免每次热更新都新建连接池。
  var __sntPostgresClient: postgres.Sql | undefined;
}

export function createPostgresClient() {
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL");
  }

  if (!globalThis.__sntPostgresClient) {
    // 当前项目直接连接阿里 PostgreSQL。max 不宜过大，避免 Next API 并发时打满 PostgreSQL 连接数。
    globalThis.__sntPostgresClient = postgres(databaseUrl, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  return globalThis.__sntPostgresClient;
}

export function toVectorLiteral(values: number[]) {
  // pgvector 插入/查询时需要 "[0.1,0.2]" 这种字面量格式；统一保留 8 位小数让 SQL 更稳定。
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}
