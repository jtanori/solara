import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import { sessions, subscriptions, users } from "@/db/schema";
import type { Role } from "@/lib/types";

export const SESSION_COOKIE = "solara_session";
const SESSION_DURATION = 1000 * 60 * 60 * 24 * 30;

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash || hash.length !== 128) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DURATION);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
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
  const [user] = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, stripeCustomerId: users.stripeCustomerId })
    .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date()))).limit(1);
  if (!user) return null;
  return { ...user, plan: await hasPremiumAccess(user.id) ? "paid" as const : "free" as const };
}
export function canManageUsers(role: Role) { return role === "owner" || role === "admin"; }
export function canEditKnowledge(role: Role) { return role === "owner" || role === "editor"; }
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { const host = request.headers.get("host"); return !!host && new URL(origin).host === host; } catch { return false; }
}
