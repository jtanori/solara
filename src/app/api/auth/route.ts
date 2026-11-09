import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { createSession, hashToken, SESSION_COOKIE } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/passwords";
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
  clearAuthFailures,
  consumeRateLimit,
  getRateLimitState,
  keyFor,
  recordAuthFailure,
  resetRateLimit,
} from "@/lib/rate-limit";

const DUMMY_PASSWORD_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;

type AuthPayload = {
  mode?: unknown;
  email?: unknown;
  password?: unknown;
  name?: unknown;
};

function tooManyAttempts(es: boolean, retryAfterSeconds: number) {
  return NextResponse.json(
    {
      error: es
        ? "Demasiados intentos. Inténtalo de nuevo más tarde."
        : "Too many attempts. Please try again later.",
    },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) },
    },
  );
}

function retryAfterSeconds(date: Date): number {
  return Math.max(1, Math.ceil((date.getTime() - Date.now()) / 1000));
}

function sessionResponse(name: string, token: string, expiresAt: Date) {
  const response = NextResponse.json({ ok: true, name });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
  return response;
}

export async function POST(request: Request) {
  const es = (await getLocale()) === "es";

  let data: AuthPayload;
  try {
    data = await request.json() as AuthPayload;
  } catch {
    return NextResponse.json(
      { error: es ? "Solicitud no válida." : "Invalid request." },
      { status: 400 },
    );
  }

  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const password = typeof data.password === "string" ? data.password : "";
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const mode = data.mode;

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || email.length > 254
    || password.length < 10
    || password.length > 128
  ) {
    return NextResponse.json(
      {
        error: es
          ? "Introduce un correo válido y una contraseña de 10 a 128 caracteres."
          : "Enter a valid email and a password of 10–128 characters.",
      },
      { status: 400 },
    );
  }

  const ip = clientIp(request);

  try {
    if (mode === "signup") {
      if (name.length < 1 || name.length > 100) {
        return NextResponse.json(
          { error: es ? "Introduce tu nombre." : "Please enter your name." },
          { status: 400 },
        );
      }

      const ipLimit = await consumeRateLimit(
        keyFor("signup:ip", ip),
        AUTH_RATE_LIMITS.signupIp,
        "signup_ip",
      );
      if (!ipLimit.allowed) return tooManyAttempts(es, ipLimit.retryAfterSeconds);

      const emailLimit = await consumeRateLimit(
        keyFor("signup:email", email),
        AUTH_RATE_LIMITS.signupEmail,
        "signup_email",
      );
      if (!emailLimit.allowed) return tooManyAttempts(es, emailLimit.retryAfterSeconds);

      const mail = createMailTransport();

      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing.length) {
        return NextResponse.json(
          {
            error: es
              ? "Ya existe una cuenta con este correo. Intenta iniciar sesión."
              : "An account already exists for this email. Try signing in.",
          },
          { status: 409 },
        );
      }

      const [user] = await db.insert(users).values({
        name,
        email,
        passwordHash: await hashPassword(password),
        role: "user",
        plan: "free",
      }).returning();

      const verification = await createEmailVerificationToken(user.id);
      if (verification.status === "created") {
        try {
          await mail.send(emailVerificationMessage({
            to: user.email,
            name: user.name,
            url: emailVerificationUrl(verification.token, es ? "es" : "en"),
            locale: es ? "es" : "en",
          }));
        } catch (error) {
          console.error(
            "Verification email delivery failed",
            error instanceof Error ? error.message : "unknown error",
          );
        }
      }

      const session = await createSession(user.id);
      return sessionResponse(user.name, session.token, session.expiresAt);
    }

    if (mode === "login") {
      const ipLimit = await consumeRateLimit(
        keyFor("login:ip", ip),
        AUTH_RATE_LIMITS.loginIp,
        "login_ip",
      );
      if (!ipLimit.allowed) return tooManyAttempts(es, ipLimit.retryAfterSeconds);

      const emailKey = keyFor("login:email", email);
      const pairKey = keyFor("login:pair", `${ip}:${email}`);
      const pairState = await getRateLimitState(pairKey);
      if (pairState?.blockedUntil && pairState.blockedUntil.getTime() > Date.now()) {
        return tooManyAttempts(es, retryAfterSeconds(pairState.blockedUntil));
      }

      const [found] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      const passwordMatches = await verifyPassword(
        password,
        found?.passwordHash ?? DUMMY_PASSWORD_HASH,
      );

      if (!found || !passwordMatches) {
        const emailLimit = await consumeRateLimit(
          emailKey,
          AUTH_RATE_LIMITS.loginEmail,
          "login_email",
        );
        if (!emailLimit.allowed) {
          return tooManyAttempts(es, emailLimit.retryAfterSeconds);
        }
        await recordAuthFailure(pairKey);
        return NextResponse.json(
          {
            error: es
              ? "El correo o la contraseña son incorrectos."
              : "Email or password is incorrect.",
          },
          { status: 401 },
        );
      }

      await clearAuthFailures(pairKey);
      await resetRateLimit(emailKey);
      const session = await createSession(found.id);
      return sessionResponse(found.name, session.token, session.expiresAt);
    }

    return NextResponse.json(
      { error: es ? "Solicitud no válida." : "Invalid request." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof MailConfigurationError) {
      return NextResponse.json(
        {
          error: es
            ? "El envío de correo aún no está configurado."
            : "Email delivery is not configured yet.",
        },
        { status: 503 },
      );
    }
    console.error(
      "Authentication error",
      error instanceof Error ? error.message : "unknown error",
    );
    return NextResponse.json(
      {
        error: es
          ? "No pudimos completar tu solicitud. Inténtalo de nuevo."
          : "Unable to complete your request. Please try again.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
