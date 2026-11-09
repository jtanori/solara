import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { emailTokens, sessions, users } from "@/db/schema";
import type { EmailTokenPurpose } from "@/lib/types";
import { withEmailLock } from "@/lib/account-lock";

export const EMAIL_TOKEN_TTL_HOURS = 24;
export const EMAIL_TOKEN_COOLDOWN_SECONDS = 60;

export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type EmailTokenCreation =
  | { status: "created"; token: string; tokenHash: string; expiresAt: Date }
  | { status: "cooldown" };

export async function createEmailVerificationToken(
  userId: string,
  purpose: EmailTokenPurpose = "account_claim",
  options: { cooldownSeconds?: number; ttlHours?: number } = {},
): Promise<EmailTokenCreation> {
  const cooldownSeconds = options.cooldownSeconds ?? EMAIL_TOKEN_COOLDOWN_SECONDS;
  const ttlHours = options.ttlHours ?? EMAIL_TOKEN_TTL_HOURS;

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user) throw new Error("Cannot issue a token for a missing user.");

    const [latest] = await tx
      .select({ createdAt: emailTokens.createdAt })
      .from(emailTokens)
      .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose)))
      .orderBy(desc(emailTokens.createdAt))
      .limit(1);

    if (latest && Date.now() - latest.createdAt.getTime() < cooldownSeconds * 1000) {
      return { status: "cooldown" };
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashEmailToken(token);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    await tx.insert(emailTokens).values({
      tokenHash,
      userId,
      purpose,
      expiresAt,
    });

    return { status: "created", token, tokenHash, expiresAt };
  });
}

export async function finalizeEmailVerificationToken(
  tokenHash: string,
  userId: string,
  purpose: EmailTokenPurpose = "account_claim",
): Promise<void> {
  await db.delete(emailTokens).where(and(
    eq(emailTokens.userId, userId),
    eq(emailTokens.purpose, purpose),
    isNull(emailTokens.usedAt),
    ne(emailTokens.tokenHash, tokenHash),
  ));
}

export async function discardEmailVerificationToken(tokenHash: string): Promise<void> {
  await db.delete(emailTokens).where(and(
    eq(emailTokens.tokenHash, tokenHash),
    isNull(emailTokens.usedAt),
  ));
}

export type AccountClaimResult =
  | { status: "claimed"; userId: string }
  | { status: "used" }
  | { status: "expired" }
  | { status: "invalid" };

export async function claimAccountWithToken(
  token: string,
  passwordHash: string,
  purpose: EmailTokenPurpose = "account_claim",
): Promise<AccountClaimResult> {
  const tokenHash = hashEmailToken(token);

  const [hint] = await db
    .select({ email: users.email })
    .from(emailTokens)
    .innerJoin(users, eq(users.id, emailTokens.userId))
    .where(and(eq(emailTokens.tokenHash, tokenHash), eq(emailTokens.purpose, purpose)))
    .limit(1);

  if (!hint) return { status: "invalid" };

  return withEmailLock(hint.email, async (tx) => {
    const now = new Date();
    const [row] = await tx
      .select()
      .from(emailTokens)
      .where(and(eq(emailTokens.tokenHash, tokenHash), eq(emailTokens.purpose, purpose)))
      .for("update");

    if (!row) return { status: "invalid" };
    if (row.usedAt) return { status: "used" };
    if (row.expiresAt.getTime() <= now.getTime()) return { status: "expired" };

    const [user] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, row.userId))
      .for("update");
    if (!user) return { status: "invalid" };

    await tx.update(users)
      .set({ passwordHash, emailVerifiedAt: now })
      .where(eq(users.id, user.id));

    await tx.update(emailTokens)
      .set({ usedAt: now })
      .where(eq(emailTokens.tokenHash, tokenHash));

    await tx.delete(emailTokens).where(and(
      eq(emailTokens.userId, user.id),
      eq(emailTokens.purpose, purpose),
      isNull(emailTokens.usedAt),
    ));

    await tx.delete(sessions).where(eq(sessions.userId, user.id));

    return { status: "claimed", userId: user.id };
  });
}

export function emailVerificationUrl(
  token: string,
  locale: "en" | "es",
  appUrl: string | undefined = process.env.APP_URL,
): string {
  const url = new URL("/verify-email", appUrl?.trim() || "http://localhost:3000");
  url.searchParams.set("lang", locale);
  url.hash = `token=${token}`;
  return url.toString();
}
