import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { log } from "@/lib/log";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function normalizeDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  if (isLoopback(url.hostname)) return url.toString();

  const sslmode = url.searchParams.get("sslmode")?.trim().toLowerCase();
  const sslFlag = url.searchParams.get("ssl")?.trim().toLowerCase();
  if (sslmode === "disable" || sslFlag === "false" || sslFlag === "0") {
    throw new Error("Hosted DATABASE_URL must not disable TLS.");
  }

  url.searchParams.delete("ssl");
  if (sslmode !== "verify-full") {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

function poolMax(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.DB_POOL_MAX ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 5;
  return Math.min(parsed, 20);
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
