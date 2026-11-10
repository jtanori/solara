import { desc, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";

export async function listRateLimitReport(limit = 50) {
  return db
    .select()
    .from(rateLimits)
    .orderBy(
      sql`${rateLimits.lastTriggeredAt} desc nulls last`,
      desc(rateLimits.failureCount),
    )
    .limit(limit);
}
