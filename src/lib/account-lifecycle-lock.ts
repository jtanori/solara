import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { coordinationPool, db as appDb, pool as appPool } from "@/db";
import { log } from "@/lib/log";

/**
 * Serialises account lifecycle work (checkout and deletion) for one user.
 *
 * The lock is a row in `account_lifecycle_leases`, not a PostgreSQL advisory
 * lock. A session-level advisory lock is not preserved through PgBouncer
 * transaction pooling: the acquire and the work can land on different sessions.
 * A lease row is visible to every pooler and every instance.
 *
 * The row is taken over atomically only after `expires_at` has passed, and the
 * owner is fenced inside the final database transaction. A stalled process
 * therefore cannot keep operating after another process has taken its lease.
 *
 * Lease queries use the app pool: they are short, autocommit statements and are
 * never held across provider I/O. The compatibility advisory lock, which IS held
 * across provider I/O during the cutover, uses the separate coordination pool so
 * it cannot starve the lease queries.
 *
 * Compatibility is opt-in for a controlled old/new overlap: setting
 * `LIFECYCLE_ADVISORY_COMPAT=1` makes the lease holder also take the old
 * one-argument advisory lock, excluding pre-lease instances that still use
 * `pg_advisory_xact_lock(hashtext(...))`. It is off by default; a normal
 * deployment drains pre-lease instances instead.
 */

const LOCK_WAIT_MS = 5_000;
const RETRY_INITIAL_MS = 50;
const RETRY_MAX_MS = 250;
const LEASE_TTL_MS = 60_000;
const LEASE_HEARTBEAT_MS = 15_000;

const ACQUIRE_SQL = `
  insert into account_lifecycle_leases (user_id, owner, expires_at, created_at, updated_at)
  values ($1::uuid, $2::uuid, now() + ($3::int * interval '1 millisecond'), now(), now())
  on conflict (user_id) do update
    set owner = excluded.owner,
        expires_at = excluded.expires_at,
        updated_at = now()
    where account_lifecycle_leases.expires_at <= now()
  returning owner
`;

const HEARTBEAT_SQL = `
  update account_lifecycle_leases
  set expires_at = now() + ($3::int * interval '1 millisecond'),
      updated_at = now()
  where user_id = $1::uuid
    and owner = $2::uuid
    and expires_at > now()
  returning user_id
`;

const RELEASE_SQL = `
  delete from account_lifecycle_leases
  where user_id = $1::uuid and owner = $2::uuid
  returning user_id
`;

export type LifecycleDb = NodePgDatabase<Record<string, unknown>>;

export type LeaseExecutor = {
  execute(query: SQL): Promise<unknown>;
};

export type LifecycleLease = {
  owner: string;
  assertHeld(executor: LeaseExecutor): Promise<void>;
  stopHeartbeat(): Promise<void>;
  isLost(): boolean;
};

export type LifecycleCallback<T> = (db: LifecycleDb, lease: LifecycleLease) => Promise<T>;

export type LifecycleLockDeps = {
  /** Lease-query pool. Defaults to the app pool. */
  pool?: Pool;
  /** Compatibility advisory-lock pool. Defaults to the coordination pool. */
  compatPool?: Pool;
  db?: LifecycleDb;
  waitMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  ttlMs?: number;
  heartbeatMs?: number;
  advisoryCompat?: boolean;
  owner?: string;
  now?: () => number;
};

export class LifecycleLeaseTimeout extends Error {
  constructor() {
    super("LifecycleLeaseTimeout");
    this.name = "LifecycleLeaseTimeout";
  }
}

export class LifecycleLeaseLost extends Error {
  constructor() {
    super("LifecycleLeaseLost");
    this.name = "LifecycleLeaseLost";
  }
}

export class CoordinationPoolUnavailable extends Error {
  constructor(cause?: unknown) {
    super("CoordinationPoolUnavailable", cause === undefined ? undefined : { cause });
    this.name = "CoordinationPoolUnavailable";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function keyFor(userId: string): string {
  return `account-deletion:${userId}`;
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

function isLockTimeout(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "55P03";
}

/**
 * Default pool assignment, exported so the production wiring is testable
 * without injecting both pools around it.
 */
export function lifecyclePools(deps: LifecycleLockDeps = {}): { lease: Pool; compat: Pool } {
  return {
    lease: deps.pool ?? appPool,
    compat: deps.compatPool ?? coordinationPool,
  };
}

export async function withAccountLifecycleLock<T>(
  userId: string,
  fn: LifecycleCallback<T>,
  deps: LifecycleLockDeps = {},
): Promise<T> {
  const { lease: pool, compat: compatPool } = lifecyclePools(deps);
  const database = deps.db ?? appDb;
  const owner = deps.owner ?? randomUUID();
  const waitMs = deps.waitMs ?? LOCK_WAIT_MS;
  const retryInitialMs = deps.retryInitialMs ?? RETRY_INITIAL_MS;
  const retryMaxMs = deps.retryMaxMs ?? RETRY_MAX_MS;
  const ttlMs = deps.ttlMs ?? LEASE_TTL_MS;
  const heartbeatMs = deps.heartbeatMs ?? LEASE_HEARTBEAT_MS;
  const now = deps.now ?? Date.now;
  const advisoryCompat = deps.advisoryCompat ?? process.env.LIFECYCLE_ADVISORY_COMPAT === "1";

  let compatClient: PoolClient | undefined;
  let acquired = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatInFlight: Promise<void> = Promise.resolve();
  let stopped = false;
  let lost = false;

  const markLost = () => {
    lost = true;
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const stopHeartbeat = async () => {
    stopped = true;
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    await heartbeatInFlight.catch(() => undefined);
  };

  const lease: LifecycleLease = {
    owner,
    isLost: () => lost,
    assertHeld: async executor => {
      const result = await executor.execute(sql`
        select 1
        from account_lifecycle_leases
        where user_id = ${userId}::uuid
          and owner = ${owner}::uuid
          and expires_at > now()
        for update
      `);
      if (rowsOf(result).length === 0) {
        markLost();
        throw new LifecycleLeaseLost();
      }
    },
    stopHeartbeat,
  };

  const acquire = async () => {
    const deadline = now() + waitMs;
    let retryMs = retryInitialMs;
    while (!acquired) {
      try {
        const { rows } = await pool.query<{ owner: string }>(ACQUIRE_SQL, [userId, owner, ttlMs]);
        acquired = rows[0]?.owner === owner;
      } catch (error) {
        throw new CoordinationPoolUnavailable(error);
      }
      if (acquired) return;
      if (now() >= deadline) throw new LifecycleLeaseTimeout();

      const jitter = Math.floor(Math.random() * 25);
      await delay(Math.min(retryMs + jitter, retryMaxMs));
      retryMs = Math.min(retryMs * 2, retryMaxMs);
    }
  };

  const scheduleHeartbeat = () => {
    if (stopped || lost) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      heartbeatInFlight = (async () => {
        try {
          const { rows } = await pool.query<{ user_id: string }>(HEARTBEAT_SQL, [userId, owner, ttlMs]);
          if (rows.length === 0) markLost();
        } catch (error) {
          markLost();
          log.warn("lifecycle.lease_heartbeat_failed", {
            userId,
            code: (error as { code?: string } | null)?.code ?? "unknown",
          });
        }
        if (!stopped && !lost) scheduleHeartbeat();
      })();
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  };

  const release = async () => {
    if (!acquired) return;
    try {
      await pool.query(RELEASE_SQL, [userId, owner]);
    } catch (error) {
      // The lease is time-bounded: a failed release becomes available after TTL.
      log.warn("lifecycle.lease_release_failed", {
        userId,
        code: (error as { code?: string } | null)?.code ?? "unknown",
      });
    }
  };

  try {
    if (advisoryCompat) {
      try {
        compatClient = await compatPool.connect();
      } catch (error) {
        throw new CoordinationPoolUnavailable(error);
      }
      try {
        await compatClient.query("begin");
        await compatClient.query("select set_config('lock_timeout', $1, true)", [`${waitMs}ms`]);
        await compatClient.query("select pg_advisory_xact_lock(hashtext($1))", [keyFor(userId)]);
      } catch (error) {
        try {
          await compatClient.query("rollback");
        } catch {
          // The client is destroyed below.
        }
        compatClient.release(true);
        compatClient = undefined;
        throw isLockTimeout(error) ? new LifecycleLeaseTimeout() : error;
      }
    }

    await acquire();
    scheduleHeartbeat();

    try {
      return await fn(database, lease);
    } finally {
      await stopHeartbeat();
      await release();
    }
  } finally {
    if (compatClient) {
      let destroy = false;
      try {
        await compatClient.query("commit");
      } catch {
        destroy = true;
        try {
          await compatClient.query("rollback");
        } catch {
          // Already unusable; destroy below.
        }
      } finally {
        compatClient.release(destroy);
      }
    }
  }
}
