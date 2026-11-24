import "dotenv/config";
import { lt } from "drizzle-orm";
import { db, pool } from "../src/db";
import { rateLimits } from "../src/db/schema";

async function main() {
  const deleted = await db
    .delete(rateLimits)
    .where(lt(rateLimits.expiresAt, new Date()))
    .returning({ key: rateLimits.key });
  console.log(`Deleted ${deleted.length} expired rate-limit row${deleted.length === 1 ? "" : "s"}.`);
}

main()
  .catch((error) => {
    console.error("Unable to clean rate-limit state:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
