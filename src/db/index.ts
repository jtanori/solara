import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { log } from "@/lib/log";
import { normalizeDatabaseUrl, poolMax } from "@/lib/database-url";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

export function databasePoolConfig(
  rawUrl: string,
  env: Record<string, string | undefined> = process.env,
): PoolConfig {
  return {
    connectionString: normalizeDatabaseUrl(rawUrl),
    max: poolMax(env),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options: "-c statement_timeout=15000",
  };
}

export function createDatabasePool(
  rawUrl: string,
  env: Record<string, string | undefined> = process.env,
): Pool {
  const pool = new Pool(databasePoolConfig(rawUrl, env));
  pool.on("error", (error) => {
    log.error("db.pool_error", { error });
  });
  return pool;
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  createDatabasePool(databaseUrl);

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
