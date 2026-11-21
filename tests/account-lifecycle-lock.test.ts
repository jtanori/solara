import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { Pool } from "pg";
import {
  CoordinationPoolUnavailable,
  LifecycleLeaseLost,
  LifecycleLeaseTimeout,
  lifecyclePools,
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

async function assertEventually(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = performance.now() + 5_000;
  for (;;) {
    if (await check()) return;
    assert.ok(performance.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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

test("lease: heartbeat renews expiry and excludes waiters until release", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();

  try {
    await withAccountLifecycleLock(userId, async (database, lease) => {
      // Keep the production TTL: a busy runner can legitimately miss a 150ms
      // test lease. Observe committed renewal, not survival after a fixed sleep.
      // Two distinct extensions also exercise heartbeat rescheduling.
      for (let renewal = 0; renewal < 2; renewal++) {
        const before = await probePool.query<{ expiry: string }>(
          "select expires_at::text as expiry from account_lifecycle_leases where user_id = $1::uuid",
          [userId],
        );
        assert.equal(before.rows.length, 1);
        await assertEventually(async () => {
          const { rows } = await probePool.query<{ owner: string; live: boolean; extended: boolean }>(
            `select owner, expires_at > now() as live, expires_at > $2::timestamptz as extended
             from account_lifecycle_leases where user_id = $1::uuid`,
            [userId, before.rows[0].expiry],
          );
          assert.equal(rows[0]?.owner, lease.owner, "renewal retains the same owner");
          assert.equal(rows[0]?.live, true, "the renewing lease remains live");
          return rows[0]?.extended === true;
        }, `heartbeat ${renewal + 1} must commit a later expiry`);
      }

      assert.equal(lease.isLost(), false);
      await lease.assertHeld(database);
      await assert.rejects(
        withAccountLifecycleLock(userId, async () => "second", { pool, waitMs: 120, advisoryCompat: false }),
        (error: unknown) => error instanceof LifecycleLeaseTimeout,
      );
    }, { pool, waitMs: 1_000, heartbeatMs: 40, advisoryCompat: false });

    assert.equal(await leaseOwner(userId), null, "the lease was released after the heartbeat stopped");
  } finally {
    await clearLease(userId);
  }
});

for (const invalidation of ["expired", "replaced"] as const) {
  test(`lease: heartbeat fails closed when the lease is ${invalidation}`, gated, async () => {
    assertLocalDisposableDatabase();
    const userId = randomUUID();
    const replacementOwner = invalidation === "replaced" ? randomUUID() : null;

    try {
      await withAccountLifecycleLock(userId, async (database, lease) => {
        // Change persisted state before the next heartbeat rather than racing
        // the runner against a sub-second TTL. The real SQL must reject it.
        const change = replacementOwner ? "owner = $3::uuid" : "expires_at = now() - interval '1 second'";
        const invalidated = await probePool.query<{ owner: string; expiry: string }>(
          `update account_lifecycle_leases set ${change}
           where user_id = $1::uuid and owner = $2::uuid
           returning owner, expires_at::text as expiry`,
          replacementOwner ? [userId, lease.owner, replacementOwner] : [userId, lease.owner],
        );
        assert.equal(invalidated.rows.length, 1);
        await assertEventually(() => lease.isLost(), `heartbeat must reject a lease that is ${invalidation}`);

        const after = await probePool.query<{ owner: string; expiry: string }>(
          "select owner, expires_at::text as expiry from account_lifecycle_leases where user_id = $1::uuid",
          [userId],
        );
        assert.deepEqual(after.rows, invalidated.rows, "a late heartbeat cannot revive or rewrite the lease");
        await assert.rejects(lease.assertHeld(database), (error: unknown) => error instanceof LifecycleLeaseLost);
      }, { pool, waitMs: 1_000, heartbeatMs: 40, advisoryCompat: false });

      assert.equal(await leaseOwner(userId), replacementOwner, "release deletes only the original owner's row");
    } finally {
      await clearLease(userId);
    }
  });
}

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

test("lease: default pools are app for leases and coordination for compatibility", gated, async () => {
  assertLocalDisposableDatabase();
  const { coordinationPool, pool: appPool } = await import("../src/db");
  const pools = lifecyclePools();
  assert.equal(pools.lease, appPool, "lease queries default to the app pool");
  assert.equal(pools.compat, coordinationPool, "compatibility defaults to the coordination pool");
});

test("lease: compatibility is opt-in, not the default", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();
  const previous = process.env.LIFECYCLE_ADVISORY_COMPAT;
  delete process.env.LIFECYCLE_ADVISORY_COMPAT;

  try {
    await withAccountLifecycleLock(userId, async () => {
      assert.equal(await probeOldAdvisoryLock(userId), true, "no old advisory lock is taken by default");
    }, { pool, waitMs: 1_000 });
  } finally {
    if (previous === undefined) delete process.env.LIFECYCLE_ADVISORY_COMPAT;
    else process.env.LIFECYCLE_ADVISORY_COMPAT = previous;
    await clearLease(userId);
  }
});

test("lease: default compatibility uses the coordination pool", gated, async () => {
  assertLocalDisposableDatabase();
  const userId = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });

  try {
    const held = withAccountLifecycleLock(userId, async () => {
      started();
      await gate;
    }, { advisoryCompat: true, waitMs: 1_000 });

    await startedPromise;
    // This scan intentionally uses the default coordination name: the behavior
    // under test is that the *default* compatibility path uses that pool. A
    // foreign session can only make this pass, not fail — unlike the app-pool
    // assertion in checkout-deletion-race.test.ts (#197).
    const { rows } = await probePool.query<{ count: number }>(
      `select count(*)::int as count
       from pg_stat_activity
       where application_name = 'solara-coordination'
         and state = 'idle in transaction'`,
    );
    assert.ok((rows[0]?.count ?? 0) >= 1, "compatibility transaction is on the coordination pool");

    release();
    await held;
  } finally {
    release();
    await clearLease(userId);
  }
});

test("lease: six default holders do not hit a compatibility pool cap", gated, async () => {
  assertLocalDisposableDatabase();
  const userIds = Array.from({ length: 6 }, () => randomUUID());
  const previous = process.env.LIFECYCLE_ADVISORY_COMPAT;
  delete process.env.LIFECYCLE_ADVISORY_COMPAT;

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  let allStarted!: () => void;
  const allStartedPromise = new Promise<void>(resolve => { allStarted = resolve; });
  const promises: Promise<unknown>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    for (const userId of userIds) {
      promises.push(withAccountLifecycleLock(userId, async () => {
        started += 1;
        if (started === userIds.length) allStarted();
        await gate;
      }, {}));
    }

    await Promise.race([
      allStartedPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("default lifecycle concurrency stalled")), 5_000);
      }),
    ]);
    assert.equal(started, userIds.length, "all six default holders acquired");
  } finally {
    if (timer) clearTimeout(timer);
    release();
    await Promise.allSettled(promises);
    if (previous === undefined) delete process.env.LIFECYCLE_ADVISORY_COMPAT;
    else process.env.LIFECYCLE_ADVISORY_COMPAT = previous;
    await Promise.all(userIds.map(clearLease));
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
