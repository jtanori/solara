import "dotenv/config";
import path from "node:path";
import { and, inArray, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { accountLifecycleLeases } from "../src/db/schema";

/**
 * Deletes leases the database considers expired. Time comes from `now()`, never
 * the application clock: a skewed process must not delete a live lease and let
 * another owner take over. The optional scope exists for focused tests; the CLI
 * always runs without it.
 */
export async function cleanupExpiredAccountLeases(
  database: typeof db = db,
  userIds?: string[],
): Promise<number> {
  const expired = sql`${accountLifecycleLeases.expiresAt} < now()`;
  const where = userIds
    ? and(expired, inArray(accountLifecycleLeases.userId, userIds))
    : expired;
  const deleted = await database
    .delete(accountLifecycleLeases)
    .where(where)
    .returning({ userId: accountLifecycleLeases.userId });
  return deleted.length;
}

async function main() {
  const count = await cleanupExpiredAccountLeases();
  console.log(`Deleted ${count} expired account-lease row${count === 1 ? "" : "s"}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("cleanup-account-leases.ts")) {
  main()
    .catch((error) => {
      console.error("Unable to clean account leases:", error instanceof Error ? error.message : "unknown error");
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
