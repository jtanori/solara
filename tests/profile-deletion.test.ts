import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

/*
 * The one test that touches the shipped deletion path.
 *
 * `tests/account-deletion.test.ts` proves `writeAccountDeletion` calls its
 * writer in the right order, but it hands in its own writer — so it cannot see
 * `defaultDeleteUser` invert *its* two statements around the helper. Mutating
 * that function back to delete-then-insert leaves that whole file green, which
 * is how the original `23503` reached production behind a passing suite.
 *
 * Only Postgres can answer the question this file asks: is the statement pair
 * the route issues actually accepted, and does it leave the row behind? It
 * therefore lives in its own DB-gated file so the DB-free suite stays DB-free.
 *
 * Everything that needs `DATABASE_URL` is imported *inside* the test: a static
 * `import "@/db"` would throw at module load and turn this into a failure — not
 * a skip — for anyone running the suite without a database (issue #135).
 */

test("the route's own deletion transaction: audit row first, then the delete", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1" ? "needs RUN_INTEGRATION_TESTS=1 and a local database" : false,
}, async () => {
  const { eq } = await import("drizzle-orm");
  const { db, pool } = await import("../src/db");
  const { auditLogs, users } = await import("../src/db/schema");
  const { defaultDeleteUser } = await import("../src/app/api/profile/route");

  // The blast radius of a mistake here is "delete the wrong database", so this
  // refuses to run anywhere but a local disposable one — same guard as
  // tests/billing-integration.test.ts.
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  assert.ok(
    ["localhost", "127.0.0.1"].includes(host),
    "Deletion integration tests must run against a local disposable database",
  );

  const token = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ name: "Deletion probe", email: `deletion-${token}@example.test`, passwordHash: "not-a-login" })
    .returning({ id: users.id });

  // The assertion is in `await` itself: if the route's statements were in the
  // buggy order this rejects with 23503 (on `error.cause.code`) and the test
  // fails before reaching the checks below.
  await defaultDeleteUser(user.id);

  const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
  assert.deepEqual(survivors, [], "the account is gone");

  const rows = await db.select().from(auditLogs).where(eq(auditLogs.target, user.id));
  assert.equal(rows.length, 1, "exactly one audit row was written");
  assert.equal(rows[0].action, "account:delete");
  // `on delete set null` fires on the delete that follows the insert: this is
  // the property the row exists for, and the reason the insert must come first.
  assert.equal(rows[0].actorId, null, "actor_id was nulled by ON DELETE SET NULL");
  assert.equal(rows[0].target, user.id, "target keeps the deleted id");

  // Leave no trace: the deleted user is gone, but its audit row is not.
  await db.delete(auditLogs).where(eq(auditLogs.target, user.id));
});

/*
 * One teardown for the module-level pool. Ending it inside a test closes it for
 * every later test in the file.
 */
after(async () => {
  if (process.env.RUN_INTEGRATION_TESTS !== "1") return;
  const { pool } = await import("../src/db");
  await pool.end();
});
