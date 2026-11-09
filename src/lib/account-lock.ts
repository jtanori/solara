import { sql } from "drizzle-orm";
import { db } from "@/db";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function accountLockKey(email: string): string {
  return `account:${email.trim().toLowerCase()}`;
}

async function acquireAdvisoryLock(tx: DbTransaction, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function withEmailLock<T>(
  email: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, accountLockKey(email));
    return fn(tx);
  });
}

export async function withLoginLocks<T>(
  ip: string,
  email: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, `ip:${ip}`);
    await acquireAdvisoryLock(tx, accountLockKey(email));
    return fn(tx);
  });
}
