import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, mock } from "node:test";
import { inArray } from "drizzle-orm";
import { db, pool } from "../src/db";
import { accountLifecycleLeases } from "../src/db/schema";
import { cleanupExpiredAccountLeases } from "../scripts/cleanup-account-leases";

const gated = {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1" ? "needs RUN_INTEGRATION_TESTS=1 and a local database" : false,
};

function assertLocalDisposableDatabase() {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error(`cleanup tests must run against a local disposable database, got host "${host}"`);
  }
}

after(async () => {
  if (process.env.RUN_INTEGRATION_TESTS !== "1") return;
  await pool.end();
});

test("cleanup: database time, not the application clock, decides expiry", gated, async () => {
  assertLocalDisposableDatabase();
  const expiredUserId = randomUUID();
  const futureUserId = randomUUID();
  const owner = randomUUID();

  try {
    await db.insert(accountLifecycleLeases).values([
      {
        userId: expiredUserId,
        owner: randomUUID(),
        expiresAt: new Date(Date.now() - 60_000),
      },
      {
        userId: futureUserId,
        owner,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    ]);

    let deleted = 0;
    try {
      /*
       * An application clock one day ahead would delete the future row if the
       * cleanup used `new Date()`. The database's `now()` must ignore it.
       */
      mock.timers.enable({ apis: ["Date"], now: Date.now() + 86_400_000 });
      deleted = await cleanupExpiredAccountLeases(db, [expiredUserId, futureUserId]);
    } finally {
      mock.timers.reset();
    }

    assert.equal(deleted, 1, "only the database-expired row was deleted");
    const remaining = await db
      .select({ userId: accountLifecycleLeases.userId })
      .from(accountLifecycleLeases)
      .where(inArray(accountLifecycleLeases.userId, [expiredUserId, futureUserId]));
    assert.deepEqual(
      remaining.map(row => row.userId).sort(),
      [futureUserId],
      "the future row survived the skewed application clock",
    );
  } finally {
    mock.timers.reset();
    await db
      .delete(accountLifecycleLeases)
      .where(inArray(accountLifecycleLeases.userId, [expiredUserId, futureUserId]));
  }
});
