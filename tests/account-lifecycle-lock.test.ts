import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { Pool } from "pg";
import {
  CoordinationPoolUnavailable,
  LifecycleLeaseLost,
  LifecycleLeaseTimeout,
  type LifecycleLease,
  withAccountLifecycleLock,
} from "../src/lib/account-lifecycle-lock";

const gated = {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1" ? "needs RUN_INTEGRATION_TESTS=1 and a local database" : false,
};

function assertLocalDisposableDatabase() {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error(`lifecycle-lock tests must run against a local disposable database, got host "${host}"`);
  }
}

const appName = `solara-coordination-test-${randomUUID()}`;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 2_000,
  application_name: appName,
  allowExitOnIdle: true,
});

const probePool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  application_name: `solara-lease-probe-${randomUUID()}`,
  allowExitOnIdle: true,
});

after(async () => {
  if (process.env.RUN_INTEGRATION_TESTS !== "1") return;
  await Promise.all([pool.end(), probePool.end()]);
});

async function clearLease(userId: string) {
  await pool.query("delete from account_lifecycle_leases where user_id = $1::uuid", [userId]);
}

async function leaseOwner(userId: string): Promise<string | null> {
  const { rows } = await probePool.query<{ owner: string }>(
    "select owner from account_lifecycle_leases where user_id = $1::uuid",
    [userId],
  );
  return rows[0]?.owner ?? null;
}

async function probeOldAdvisoryLock(userId: string): Promise<boolean> {
  const client = await probePool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as locked",
      [`account-deletion:${userId}`],
    );
    const locked = rows[0]?.locked === true;
    if (locked) await client.query("select pg_advisory_unlock(hashtext($1))", [`account-deletion:${userId}`]);
    return locked;
  } finally {
    client.release();
  }
}

test("lease: the same user is serialised and a timed-out waiter fails closed", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });

  try {
    const first = withAccountLifecycleLock(userId, async () => {
      firstStarted();
      await firstGate;
      return "first";
    }, { pool, waitMs: 1_000, advisoryCompat: false });

    await started;
    assert.ok(await leaseOwner(userId), "the first holder owns the lease");

    await assert.rejects(
      withAccountLifecycleLock(userId, async () => "second", { pool, waitMs: 120, advisoryCompat: false }),
      (error: unknown) => error instanceof LifecycleLeaseTimeout,
    );

    releaseFirst();
    assert.equal(await first, "first");
    assert.equal(await leaseOwner(userId), null, "the lease was released");
    assert.equal(
      await withAccountLifecycleLock(userId, async () => "third", { pool, waitMs: 1_000, advisoryCompat: false }),
      "third",
    );
  } finally {
    releaseFirst();
    await clearLease(userId);
  }
});

test("lease: different users proceed independently", gated, async () => {
  assertLocalDisposableDatabase();
  const userA = randomUUID();
  const userB = randomUUID();
  let releaseA!: () => void;
  const gateA = new Promise<void>(resolve => { releaseA = resolve; });
  let startedA!: () => void;
  const started = new Promise<void>(resolve => { startedA = resolve; });

  try {
    const first = withAccountLifecycleLock(userA, async () => {
      startedA();
      await gateA;
      return "a";
    }, { pool, waitMs: 1_000, advisoryCompat: false });

    await started;
    assert.equal(
      await withAccountLifecycleLock(userB, async () => "b", { pool, waitMs: 500, advisoryCompat: false }),
      "b",
      "a different user is not blocked",
    );
    releaseA();
    assert.equal(await first, "a");
  } finally {
    releaseA();
    await Promise.all([clearLease(userA), clearLease(userB)]);
  }
});

test("lease: a throwing body releases the lease", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();

  try {
    await assert.rejects(
      withAccountLifecycleLock(userId, async () => {
        throw new Error("body failed");
      }, { pool, waitMs: 1_000, advisoryCompat: false }),
      /body failed/,
    );
    assert.equal(await leaseOwner(userId), null, "the lease is free after a throw");
  } finally {
    await clearLease(userId);
  }
});

test("lease: an expired lease is taken over and the old owner is fenced", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();
  const oldOwner = randomUUID();
  let oldLease: LifecycleLease | undefined;

  try {
    await pool.query(
      `insert into account_lifecycle_leases (user_id, owner, expires_at, created_at, updated_at)
       values ($1::uuid, $2::uuid, now() - interval '1 second', now(), now())`,
      [userId, oldOwner],
    );

    await withAccountLifecycleLock(userId, async (_db, lease) => {
      oldLease = lease;
      assert.notEqual(lease.owner, oldOwner, "the expired owner was replaced");
      assert.equal(await leaseOwner(userId), lease.owner);
    }, { pool, waitMs: 1_000, advisoryCompat: false });

    assert.ok(oldLease);
    await pool.query(
      `insert into account_lifecycle_leases (user_id, owner, expires_at, created_at, updated_at)
       values ($1::uuid, $2::uuid, now() + interval '1 minute', now(), now())`,
      [userId, randomUUID()],
    );

    const { db } = await import("../src/db");
    await assert.rejects(
      oldLease!.assertHeld(db),
      (error: unknown) => error instanceof LifecycleLeaseLost,
      "the old owner cannot pass the fence",
    );
  } finally {
    await clearLease(userId);
  }
});

test("lease: heartbeat keeps the lease alive past its initial TTL", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  try {
    const first = withAccountLifecycleLock(userId, async () => {
      firstStarted();
      await gate;
      return "held";
    }, { pool, waitMs: 1_000, ttlMs: 150, heartbeatMs: 40, advisoryCompat: false });

    await started;
    await new Promise(resolve => setTimeout(resolve, 350));

    const { rows } = await probePool.query<{ owner: string; live: boolean }>(
      "select owner, expires_at > now() as live from account_lifecycle_leases where user_id = $1::uuid",
      [userId],
    );
    assert.equal(rows.length, 1, "the lease still exists");
    assert.equal(rows[0]?.live, true, "heartbeat extended the lease");

    await assert.rejects(
      withAccountLifecycleLock(userId, async () => "second", { pool, waitMs: 120, advisoryCompat: false }),
      (error: unknown) => error instanceof LifecycleLeaseTimeout,
    );

    release();
    assert.equal(await first, "held");
    assert.equal(await leaseOwner(userId), null, "the lease was released after the heartbeat stopped");
  } finally {
    release();
    await clearLease(userId);
  }
});

test("lease: a lease that stops heartbeating is taken over", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let originalOwner: string | undefined;

  try {
    const first = withAccountLifecycleLock(userId, async (_db, lease) => {
      originalOwner = lease.owner;
      firstStarted();
      await gate;
      return "first";
    }, { pool, waitMs: 1_000, ttlMs: 80, heartbeatMs: 10_000, advisoryCompat: false });

    await started;
    await new Promise(resolve => setTimeout(resolve, 150));

    const result = await withAccountLifecycleLock(userId, async (_db, lease) => lease.owner, {
      pool, waitMs: 1_000, advisoryCompat: false,
    });
    assert.notEqual(result, originalOwner, "the expired lease was taken over");
    assert.equal(await leaseOwner(userId), null, "the second owner released it");

    release();
    assert.equal(await first, "first");
  } finally {
    release();
    await clearLease(userId);
  }
});

test("lease: old owner's release cannot delete a newer owner's row", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();

  let releaseOld!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  let oldStarted!: () => void;
  const oldStartedPromise = new Promise<void>(resolve => { oldStarted = resolve; });
  let releaseNew!: () => void;
  const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
  let newStarted!: () => void;
  const newStartedPromise = new Promise<void>(resolve => { newStarted = resolve; });
  let newOwner: string | undefined;
  let oldPromise: Promise<void> | undefined;
  let newPromise: Promise<void> | undefined;

  try {
    oldPromise = withAccountLifecycleLock(userId, async () => {
      oldStarted();
      await oldGate;
    }, { pool, waitMs: 1_000, ttlMs: 80, heartbeatMs: 10_000, advisoryCompat: false });

    await oldStartedPromise;
    await new Promise(resolve => setTimeout(resolve, 150));

    newPromise = withAccountLifecycleLock(userId, async (_db, lease) => {
      newOwner = lease.owner;
      newStarted();
      await newGate;
    }, { pool, waitMs: 1_000, ttlMs: 60_000, heartbeatMs: 10_000, advisoryCompat: false });

    await newStartedPromise;
    assert.ok(newOwner);
    assert.equal(await leaseOwner(userId), newOwner, "the newer owner holds the lease");

    releaseOld();
    await oldPromise;
    assert.equal(
      await leaseOwner(userId),
      newOwner,
      "the old owner's release did not delete the newer owner's row",
    );

    releaseNew();
    await newPromise;
    assert.equal(await leaseOwner(userId), null, "the newer owner released its row");
  } finally {
    releaseOld();
    releaseNew();
    await Promise.allSettled(
      [oldPromise, newPromise].filter((promise): promise is Promise<void> => Boolean(promise)),
    );
    await clearLease(userId);
  }
});

test("lease: compatibility holds the old one-argument advisory lock", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();

  try {
    await withAccountLifecycleLock(userId, async () => {
      assert.equal(await probeOldAdvisoryLock(userId), false, "old instances are excluded during cutover");
    }, { pool, compatPool: pool, waitMs: 1_000, advisoryCompat: true });

    assert.equal(await probeOldAdvisoryLock(userId), true, "the compatibility lock is released");
  } finally {
    await clearLease(userId);
  }
});

test("lease: compatibility does not starve the lease-query pool", gated, async () => {
  assertLocalDisposableDatabase();
  const userIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const compatPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    application_name: `solara-compat-test-${randomUUID()}`,
    allowExitOnIdle: true,
  });

  try {
    /*
     * The lease pool and the compatibility pool are separate connections by
     * design. Four simultaneous holders consume all four compatibility
     * connections; the lease queries must still have a pool to run on.
     */
    const results = await Promise.all(userIds.map(userId =>
      withAccountLifecycleLock(userId, async () => "ran", {
        pool,
        compatPool,
        waitMs: 1_000,
        advisoryCompat: true,
      }),
    ));
    assert.deepEqual(results, ["ran", "ran", "ran", "ran"]);
  } finally {
    await Promise.all(userIds.map(clearLease));
    await compatPool.end();
  }
});

test("lease: disabling compatibility does not hold the old advisory lock", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();

  try {
    await withAccountLifecycleLock(userId, async () => {
      assert.equal(await probeOldAdvisoryLock(userId), true, "post-cutover instances do not take the old lock");
    }, { pool, waitMs: 1_000, advisoryCompat: false });
  } finally {
    await clearLease(userId);
  }
});

test("lease: an unavailable coordination pool fails closed", gated, async () => {
  assertLocalDisposableDatabase();
  const fakePool = {
    query: async () => { throw new Error("connection refused"); },
    connect: async () => { throw new Error("connection refused"); },
  } as unknown as Pool;

  await assert.rejects(
    withAccountLifecycleLock(randomUUID(), async () => "never", {
      pool: fakePool,
      waitMs: 50,
      advisoryCompat: false,
    }),
    (error: unknown) => error instanceof CoordinationPoolUnavailable,
  );
});

test("lease: no coordination connection is left idle in a transaction", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();

  try {
    await withAccountLifecycleLock(userId, async () => "ok", {
      pool,
      compatPool: pool,
      waitMs: 1_000,
      advisoryCompat: true,
    });
    const { rows } = await probePool.query<{ count: number }>(
      "select count(*)::int as count from pg_stat_activity where application_name = $1 and state = 'idle in transaction'",
      [appName],
    );
    assert.equal(rows[0]?.count, 0, "compatibility commit released the transaction");
  } finally {
    await clearLease(userId);
  }
});
