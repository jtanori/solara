import { sql } from "drizzle-orm";
import { db } from "@/db";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withEmailLock<T>(
  email: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const key = `account:${email.trim().toLowerCase()}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return fn(tx);
  });
}
