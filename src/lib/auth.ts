import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { sessions, subscriptions, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/passwords";
import type { Role } from "@/lib/types";
import type { DbTransaction } from "@/lib/account-lock";

export { hashPassword, verifyPassword };

export const SESSION_COOKIE = "solara_session";
const SESSION_DURATION = 1000 * 60 * 60 * 24 * 30;

export function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
export async function createSession(userId: string) {
  return createSessionInTransaction(db, userId);
}

export async function createSessionInTransaction(
  executor: Pick<DbTransaction, "insert">,
  userId: string,
) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DURATION);
  await executor.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}
export async function hasPremiumAccess(userId: string) {
  const [active] = await db.select({ id: subscriptions.stripeSubscriptionId }).from(subscriptions).where(and(
    eq(subscriptions.userId, userId), eq(subscriptions.grantsAccess, true),
    inArray(subscriptions.status, ["active", "trialing"]), gt(subscriptions.currentPeriodEnd, new Date()),
  )).limit(1);
  return !!active;
}
export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, stripeCustomerId: users.stripeCustomerId, emailVerifiedAt: users.emailVerifiedAt })
    .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(
      eq(sessions.tokenHash, hashToken(token)),
      gt(sessions.expiresAt, new Date()),
      isNotNull(users.emailVerifiedAt),
    )).limit(1);
  if (!user) return null;
  return { ...user, plan: await hasPremiumAccess(user.id) ? "paid" as const : "free" as const };
}
/**
 * The role matrix lives in `lib/roles.ts` (pure, no database import) so an
 * authorization rule can be tested without Postgres. Re-exported here because
 * this module is where callers expect to find it.
 */
export { canEditKnowledge, canManageUsers, isRole, ROLES } from "@/lib/roles";
