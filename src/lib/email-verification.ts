import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { emailTokens, users } from "@/db/schema";
import type { EmailTokenPurpose } from "@/lib/types";

export const EMAIL_TOKEN_TTL_HOURS = 24;
export const EMAIL_TOKEN_COOLDOWN_SECONDS = 60;

export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type EmailTokenCreation =
  | { status: "created"; token: string; expiresAt: Date }
  | { status: "cooldown" };

export async function createEmailVerificationToken(
  userId: string,
  purpose: EmailTokenPurpose = "email_verification",
  options: { cooldownSeconds?: number; ttlHours?: number } = {},
): Promise<EmailTokenCreation> {
  const cooldownSeconds = options.cooldownSeconds ?? EMAIL_TOKEN_COOLDOWN_SECONDS;
  const ttlHours = options.ttlHours ?? EMAIL_TOKEN_TTL_HOURS;

  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ createdAt: emailTokens.createdAt })
      .from(emailTokens)
      .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose)))
      .orderBy(desc(emailTokens.createdAt))
      .limit(1);

    if (latest && Date.now() - latest.createdAt.getTime() < cooldownSeconds * 1000) {
      return { status: "cooldown" };
    }

    await tx
      .delete(emailTokens)
      .where(and(
        eq(emailTokens.userId, userId),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
      ));

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    await tx.insert(emailTokens).values({
      tokenHash: hashEmailToken(token),
      userId,
      purpose,
      expiresAt,
    });

    return { status: "created", token, expiresAt };
  });
}

export type EmailTokenConsumption =
  | { status: "verified"; userId: string }
  | { status: "used" }
  | { status: "expired" }
  | { status: "invalid" };

export async function consumeEmailToken(
  token: string,
  purpose: EmailTokenPurpose = "email_verification",
): Promise<EmailTokenConsumption> {
  const tokenHash = hashEmailToken(token);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(emailTokens)
      .where(and(eq(emailTokens.tokenHash, tokenHash), eq(emailTokens.purpose, purpose)))
      .limit(1);

    if (!row) return { status: "invalid" };
    if (row.usedAt) return { status: "used" };
    if (row.expiresAt.getTime() <= now.getTime()) return { status: "expired" };

    const [consumed] = await tx
      .update(emailTokens)
      .set({ usedAt: now })
      .where(and(
        eq(emailTokens.tokenHash, tokenHash),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, now),
      ))
      .returning({ userId: emailTokens.userId });

    if (!consumed) return { status: "used" };

    await tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, consumed.userId));
    return { status: "verified", userId: consumed.userId };
  });
}

export function emailVerificationUrl(
  token: string,
  locale: "en" | "es",
  appUrl: string | undefined = process.env.APP_URL,
): string {
  const url = new URL("/api/auth/verify", appUrl?.trim() || "http://localhost:3000");
  url.searchParams.set("token", token);
  url.searchParams.set("lang", locale);
  return url.toString();
}
