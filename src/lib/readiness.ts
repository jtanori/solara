import { Pool, type PoolClient } from "pg";
import { normalizeDatabaseUrl } from "@/lib/database-url";
import { log } from "@/lib/log";
import { EXPECTED_MIGRATIONS, type MigrationManifestEntry } from "@/lib/migration-manifest";
import { findMissingColumns, REQUIRED_INDEXES, REQUIRED_TABLES, type ColumnRow } from "@/lib/schema-verification";

export type Readiness = {
  ok: boolean;
  db: "ok" | "error";
  schema: { missing: string[]; missingColumns: string[]; missingIndexes: string[] };
  migrations: { pending: number; unexpected: number };
  auth: "ok" | "degraded";
};

export type ReadinessSnapshot = {
  dbOk: boolean;
  missingTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
  appliedHashes: string[];
  authOk: boolean;
};

export const READINESS_DEADLINE_MS = 250;
const READINESS_STATEMENT_TIMEOUT_MS = 200;

let readinessPool: Pool | undefined;

export async function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("readiness_timeout")), deadlineMs);
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
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: READINESS_DEADLINE_MS,
    options: `-c statement_timeout=${READINESS_STATEMENT_TIMEOUT_MS}`,
  });
  readinessPool.on("error", (error) => {
    const code = (error as { code?: string }).code ?? "unknown";
    log.error("ready.pool_error", { code });
  });
  return readinessPool;
}

export async function probeReadiness(pool: Pool): Promise<ReadinessSnapshot> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return { dbOk: false, missingTables: [], missingColumns: [], missingIndexes: [], appliedHashes: [], authOk: false };
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
        and table_name in ('users', 'rate_limits', 'email_tokens')
    `);
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
    const appliedHashes = migrationTable.rows[0]?.reg
      ? (await client.query<{ hash: string }>("select hash from drizzle.__drizzle_migrations")).rows.map(row => row.hash)
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
    return { dbOk: true, missingTables, missingColumns, missingIndexes, appliedHashes, authOk };
  } catch {
    await client.query("rollback").catch(() => {});
    return { dbOk: false, missingTables: [], missingColumns: [], missingIndexes: [], appliedHashes: [], authOk: false };
  } finally {
    client.release();
  }
}

export function buildReadiness(
  snapshot: ReadinessSnapshot,
  expected: MigrationManifestEntry[] = EXPECTED_MIGRATIONS,
): Readiness {
  const expectedHashes = new Set(expected.map(entry => entry.hash));
  const appliedHashes = new Set(snapshot.appliedHashes);
  const pending = expected.filter(entry => !appliedHashes.has(entry.hash)).length;
  const unexpected = snapshot.appliedHashes.filter(hash => !expectedHashes.has(hash)).length;
  const ok = snapshot.dbOk
    && snapshot.missingTables.length === 0
    && snapshot.missingColumns.length === 0
    && snapshot.missingIndexes.length === 0
    && pending === 0
    && unexpected === 0
    && snapshot.authOk;

  return {
    ok,
    db: snapshot.dbOk ? "ok" : "error",
    schema: {
      missing: snapshot.dbOk ? snapshot.missingTables : [],
      missingColumns: snapshot.dbOk ? snapshot.missingColumns : [],
      missingIndexes: snapshot.dbOk ? snapshot.missingIndexes : [],
    },
    migrations: { pending: snapshot.dbOk ? pending : expected.length, unexpected },
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
