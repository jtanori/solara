import { Pool, type PoolClient } from "pg";
import { normalizeDatabaseUrl } from "@/lib/database-url";
import { log } from "@/lib/log";
import { EXPECTED_MIGRATIONS, type MigrationManifestEntry } from "@/lib/migration-manifest";
import { findMissingColumns, REQUIRED_COLUMN_TABLES, REQUIRED_INDEXES, REQUIRED_TABLES, type ColumnRow } from "@/lib/schema-verification";

/** ADR 012: exact, ahead, behind, diverged. No numeric cap. */
export type MigrationState = "exact" | "ahead" | "behind" | "diverged";
export type AppliedMigration = { hash: string; createdAt: number | null };

export type Readiness = {
  ok: boolean;
  db: "ok" | "error";
  schema: { missing: string[]; missingColumns: string[]; missingIndexes: string[] };
  migrations: { state: MigrationState };
  auth: "ok" | "degraded";
};

export type ReadinessSnapshot = {
  dbOk: boolean;
  missingTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
  appliedMigrations: AppliedMigration[];
  authOk: boolean;
};

export const READINESS_DEADLINE_MS = 3_000;
export const READINESS_WARM_TARGET_MS = 300;
const READINESS_STATEMENT_TIMEOUT_MS = 1_000;

let readinessPool: Pool | undefined;

export async function withDeadline<T>(promise: Promise<T>, deadlineMs: number, message = "readiness_timeout"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), deadlineMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getReadinessPool(): Pool {
  if (readinessPool) return readinessPool;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  readinessPool = new Pool({
    connectionString: normalizeDatabaseUrl(databaseUrl),
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: READINESS_DEADLINE_MS,
    query_timeout: READINESS_STATEMENT_TIMEOUT_MS,
  });
  readinessPool.on("error", (error) => {
    const code = (error as { code?: string }).code ?? "unknown";
    log.error("ready.pool_error", { code });
  });
  return readinessPool;
}

function toMillis(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function probeReadiness(pool: Pool): Promise<ReadinessSnapshot> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return { dbOk: false, missingTables: [], missingColumns: [], missingIndexes: [], appliedMigrations: [], authOk: false };
  }

  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = '${READINESS_STATEMENT_TIMEOUT_MS}ms'`);
    await client.query("select 1");

    const tableRows = await client.query<{ name: string; reg: string | null }>(
      "select name, to_regclass(name) as reg from unnest($1::text[]) as name",
      [REQUIRED_TABLES],
    );
    const missingTables = tableRows.rows.filter(row => !row.reg).map(row => row.name);

    const columns = await client.query<ColumnRow>(`
      select table_name, column_name, is_nullable, data_type, column_default
      from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1::text[])
    `, [REQUIRED_COLUMN_TABLES]);
    const missingColumns = findMissingColumns(columns.rows);

    const indexes = await client.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public' and indexname = any($1)",
      [[...REQUIRED_INDEXES]],
    );
    const presentIndexes = new Set(indexes.rows.map(row => row.indexname));
    const missingIndexes = REQUIRED_INDEXES.filter(index => !presentIndexes.has(index));

    const migrationTable = await client.query<{ reg: string | null }>(
      "select to_regclass('drizzle.__drizzle_migrations') as reg",
    );
    const appliedMigrations = migrationTable.rows[0]?.reg
      ? (await client.query<{ hash: string; created_at: unknown }>(
        "select hash, created_at from drizzle.__drizzle_migrations",
      )).rows.map(row => ({ hash: row.hash, createdAt: toMillis(row.created_at) }))
      : [];

    const usersPresent = tableRows.rows.some(row => row.name === "public.users" && row.reg);
    let authOk = false;
    if (usersPresent) {
      try {
        await client.query("select 1 from public.users limit 1");
        authOk = true;
      } catch {
        authOk = false;
      }
    }

    await client.query("commit");
    return { dbOk: true, missingTables, missingColumns, missingIndexes, appliedMigrations, authOk };
  } catch {
    await client.query("rollback").catch(() => {});
    return { dbOk: false, missingTables: [], missingColumns: [], missingIndexes: [], appliedMigrations: [], authOk: false };
  } finally {
    client.release();
  }
}

/**
 * ADR 012 matrix:
 *   expected empty                               -> diverged
 *   missing expected + extra applied             -> diverged
 *   missing expected only                        -> behind
 *   exact set                                    -> exact
 *   extra applied, every createdAt > newest when -> ahead
 *   extra applied with createdAt <= newest when  -> diverged
 *   ordering unparseable (null/NaN)              -> diverged
 */
export function classifyMigrations(
  applied: AppliedMigration[],
  expected: MigrationManifestEntry[] = EXPECTED_MIGRATIONS,
): MigrationState {
  if (expected.length === 0) return "diverged";

  const expectedHashes = new Set(expected.map(entry => entry.hash));
  const appliedHashes = new Set(applied.map(row => row.hash));
  const missing = expected.filter(entry => !appliedHashes.has(entry.hash)).length;
  const extra = applied.filter(row => !expectedHashes.has(row.hash));

  if (missing > 0) return extra.length > 0 ? "diverged" : "behind";
  if (extra.length === 0) return "exact";

  const newestExpectedWhen = Math.max(...expected.map(entry => entry.when));
  if (!Number.isSafeInteger(newestExpectedWhen)) return "diverged";
  for (const row of extra) {
    if (row.createdAt === null || !Number.isSafeInteger(row.createdAt) || row.createdAt <= newestExpectedWhen) {
      return "diverged";
    }
  }
  return "ahead";
}

export function buildReadiness(
  snapshot: ReadinessSnapshot,
  expected: MigrationManifestEntry[] = EXPECTED_MIGRATIONS,
): Readiness {
  const migrationState = snapshot.dbOk ? classifyMigrations(snapshot.appliedMigrations, expected) : "diverged";
  const ok = snapshot.dbOk
    && snapshot.missingTables.length === 0
    && snapshot.missingColumns.length === 0
    && snapshot.missingIndexes.length === 0
    && (migrationState === "exact" || migrationState === "ahead")
    && snapshot.authOk;

  return {
    ok,
    db: snapshot.dbOk ? "ok" : "error",
    schema: {
      missing: snapshot.dbOk ? snapshot.missingTables : [],
      missingColumns: snapshot.dbOk ? snapshot.missingColumns : [],
      missingIndexes: snapshot.dbOk ? snapshot.missingIndexes : [],
    },
    migrations: { state: migrationState },
    auth: snapshot.dbOk && snapshot.authOk ? "ok" : "degraded",
  };
}

export async function evaluateReadiness(
  probe: () => Promise<ReadinessSnapshot>,
  expected: MigrationManifestEntry[] = EXPECTED_MIGRATIONS,
  deadlineMs: number = READINESS_DEADLINE_MS,
): Promise<Readiness> {
  return buildReadiness(await withDeadline(Promise.resolve().then(probe), deadlineMs), expected);
}

export async function getReadiness(): Promise<Readiness> {
  return evaluateReadiness(() => probeReadiness(getReadinessPool()));
}
