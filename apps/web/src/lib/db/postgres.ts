import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

declare global {
  var __sntPostgresClient: postgres.Sql | undefined;
}

export function createPostgresClient() {
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL");
  }

  if (!globalThis.__sntPostgresClient) {
    globalThis.__sntPostgresClient = postgres(databaseUrl, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  return globalThis.__sntPostgresClient;
}

export function toVectorLiteral(values: number[]) {
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}
