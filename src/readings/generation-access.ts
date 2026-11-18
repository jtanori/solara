import { and, eq, sql } from "drizzle-orm";
import { users, readings } from "@/db/schema";
import { withAccountLifecycleLock, type LifecycleDb } from "@/lib/account-lifecycle-lock";
import { GenerationBlocked } from "@/readings/execution";

export type GenerationTransaction = Parameters<Parameters<LifecycleDb["transaction"]>[0]>[0];
export async function lockVerifiedUser(tx: GenerationTransaction, userId: string) {
  const [user] = await tx.select({ id: users.id, verified: users.emailVerifiedAt }).from(users).where(eq(users.id, userId)).for("update");
  if (!user?.verified) throw new GenerationBlocked("unauthorized");
}
export async function lockOwnedReading(tx: GenerationTransaction, userId: string, readingId: string) {
  const [reading] = await tx.select().from(readings).where(and(eq(readings.id, readingId), eq(readings.userId, userId))).for("update");
  if (!reading) throw new GenerationBlocked("not_found");
  return reading;
}
/** No caller may hold this transaction across external I/O. Shared with deletion. */
export async function withGenerationTransaction<T>(
  userId: string, work: (tx: GenerationTransaction) => Promise<T>, lifecycleLock = withAccountLifecycleLock,
): Promise<T> {
  return lifecycleLock(userId, async (database, lease) => {
    await lease.stopHeartbeat();
    return database.transaction(async tx => {
      await tx.execute(sql`select set_config('lock_timeout', '2s', true), set_config('statement_timeout', '5s', true)`);
      await lease.assertHeld(tx);
      await lockVerifiedUser(tx, userId);
      return work(tx);
    });
  });
}
