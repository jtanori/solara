import "dotenv/config";
import { desc } from "drizzle-orm";
import { db, pool } from "../src/db";
import { rateLimits } from "../src/db/schema";

async function main() {
  const rows = await db
    .select()
    .from(rateLimits)
    .orderBy(desc(rateLimits.lastTriggeredAt), desc(rateLimits.failureCount))
    .limit(50);

  if (!rows.length) {
    console.log("No rate-limit state recorded.");
    return;
  }

  console.table(rows.map((row) => ({
    key: `${row.key.slice(0, 24)}…`,
    count: row.count,
    failures: row.failureCount,
    blockedUntil: row.blockedUntil?.toISOString() ?? "",
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? "",
    expiresAt: row.expiresAt.toISOString(),
  })));
}

main()
  .catch((error) => {
    console.error("Unable to read rate-limit state:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
