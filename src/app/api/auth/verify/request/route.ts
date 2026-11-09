import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getLocale } from "@/lib/i18n-server";
import { createMailTransport, MailConfigurationError } from "@/lib/mail";
import {
  createEmailVerificationToken,
  emailVerificationUrl,
} from "@/lib/email-verification";
import { emailVerificationMessage } from "@/lib/email-messages";
import {
  AUTH_RATE_LIMITS,
  clientIp,
  consumeRateLimit,
  keyFor,
} from "@/lib/rate-limit";

function tooManyAttempts(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: "Too many attempts. Please try again later." },
    { status: 429, headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) } },
  );
}

export async function POST(request: Request) {
  const locale = await getLocale();
  let data: { email?: unknown; locale?: unknown };
  try {
    data = await request.json() as { email?: unknown; locale?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return NextResponse.json({ ok: true });
  }

  const requestLocale = data.locale === "es" ? "es" : data.locale === "en" ? "en" : locale;
  const ip = clientIp(request);

  try {
    const ipLimit = await consumeRateLimit(
      keyFor("verify-request:ip", ip),
      AUTH_RATE_LIMITS.verifyRequestIp,
      "verify_request_ip",
    );
    if (!ipLimit.allowed) return tooManyAttempts(ipLimit.retryAfterSeconds);

    const emailLimit = await consumeRateLimit(
      keyFor("verify-request:email", email),
      AUTH_RATE_LIMITS.verifyRequestEmail,
      "verify_request_email",
    );
    if (!emailLimit.allowed) return tooManyAttempts(emailLimit.retryAfterSeconds);

    const mail = createMailTransport();

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user || user.emailVerifiedAt) return NextResponse.json({ ok: true });

    const token = await createEmailVerificationToken(user.id);
    if (token.status === "cooldown") return NextResponse.json({ ok: true });

    try {
      await mail.send(emailVerificationMessage({
        to: user.email,
        name: user.name,
        url: emailVerificationUrl(token.token, requestLocale),
        locale: requestLocale,
      }));
    } catch (error) {
      console.error(
        "Verification email delivery failed",
        error instanceof Error ? error.message : "unknown error",
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof MailConfigurationError) {
      return NextResponse.json(
        { error: "Email delivery is not configured." },
        { status: 503 },
      );
    }
    console.error(
      "Verification request failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json(
      { error: "Unable to complete your request. Please try again." },
      { status: 500 },
    );
  }
}
