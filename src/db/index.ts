import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { log } from "@/lib/log";
import { coordinationPoolMax, normalizeDatabaseUrl, poolMax } from "@/lib/database-url";
import { assertDatabaseEnvironment } from "./url-guard";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

// Fail closed before either pool exists. The deploy environment is the inlined
// build identity (#164); a loopback placeholder is allowed only while Next builds.
assertDatabaseEnvironment(databaseUrl, {
  deployEnv: process.env.APP_DEPLOY_ENV?.trim() || "local",
  phase: process.env.NEXT_PHASE === "phase-production-build" ? "build" : "runtime",
});

export function databasePoolConfig(
  rawUrl: string,
  env: Record<string, string | undefined> = process.env,
): PoolConfig {
  return {
    connectionString: normalizeDatabaseUrl(rawUrl),
    max: poolMax(env),
    application_name: "solara-app",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
  };
}

export function coordinationPoolConfig(
  rawUrl: string,
  env: Record<string, string | undefined> = process.env,
): PoolConfig {
  return {
    connectionString: normalizeDatabaseUrl(rawUrl),
    max: coordinationPoolMax(env),
    application_name: "solara-coordination",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    allowExitOnIdle: true,
  };
}

function withErrorListener(pool: Pool, name: string): Pool {
  pool.on("error", (error) => {
    log.error(name, { error });
  });
  return pool;
}

export function createDatabasePool(
  rawUrl: string,
  env: Record<string, string | undefined> = process.env,
): Pool {
  return withErrorListener(new Pool(databasePoolConfig(rawUrl, env)), "db.pool_error");
}

export function createCoordinationPool(
  rawUrl: string,
  env: Record<string, string | undefined> = process.env,
): Pool {
  return withErrorListener(new Pool(coordinationPoolConfig(rawUrl, env)), "db.coordination_pool_error");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaNextJsCoordinationPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  createDatabasePool(databaseUrl);

export const coordinationPool =
  globalForDb.__arenaNextJsCoordinationPool ??
  createCoordinationPool(databaseUrl);

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
  globalForDb.__arenaNextJsCoordinationPool = coordinationPool;
}

export const db = drizzle(pool);
