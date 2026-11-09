import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  createSessionInTransaction,
  SESSION_COOKIE,
} from "@/lib/auth";
import { withEmailLock } from "@/lib/account-lock";
import {
  claimAccountWithToken,
  createEmailVerificationToken,
  discardEmailVerificationToken,
  emailVerificationUrl,
  finalizeEmailVerificationToken,
} from "@/lib/email-verification";
import {
  accountClaimMessage,
  accountExistsMessage,
} from "@/lib/email-messages";
import { reportServerError } from "@/lib/error-report";
import {
  MailAmbiguousError,
  MailConfigurationError,
  type MailTransport,
} from "@/lib/mail";
import { hashPassword, verifyPassword } from "@/lib/passwords";
import {
  ACCOUNT_FAILURE_BACKOFF,
  AUTH_RATE_LIMITS,
  clearAuthFailuresTx,
  clientIp,
  consumeRateLimit,
  getRateLimitState,
  getRateLimitStateTx,
  keyFor,
  recordAuthFailureTx,
} from "@/lib/rate-limit";
import type { Locale } from "@/lib/i18n";

const PENDING_PASSWORD_HASH = "pending:no-credentials";
const DUMMY_PASSWORD_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;

type Task = () => Promise<void>;

export type AuthDeps = {
  locale: Locale;
  mail: () => MailTransport;
};

export type AuthOutcome = {
  response: Response;
  tasks: Task[];
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

function claimTask(
  user: { id: string; email: string; name: string },
  locale: Locale,
  mail: MailTransport,
): Task {
  return async () => {
    const token = await createEmailVerificationToken(user.id, "account_claim");
    if (token.status !== "created") return;
    try {
      await mail.send(accountClaimMessage({
        to: user.email,
        name: user.name,
        url: emailVerificationUrl(token.token, locale),
        locale,
      }));
      await finalizeEmailVerificationToken(token.tokenHash, user.id, "account_claim");
    } catch (error) {
      if (error instanceof MailAmbiguousError) {
        reportServerError("auth.claim_email_ambiguous", error);
      } else {
        await discardEmailVerificationToken(token.tokenHash);
        reportServerError("auth.claim_email_failed", error);
      }
    }
  };
}

function accountExistsTask(
  user: { email: string; name: string },
  locale: Locale,
  mail: MailTransport,
): Task {
  return async () => {
    try {
      await mail.send(accountExistsMessage({
        to: user.email,
        name: user.name,
        url: new URL("/account", process.env.APP_URL?.trim() || "http://localhost:3000").toString(),
        locale,
      }));
    } catch (error) {
      reportServerError("auth.account_exists_email_failed", error);
    }
  };
}

async function handleSignup(
  request: Request,
  deps: AuthDeps,
  email: string,
  name: string,
): Promise<AuthOutcome> {
  const es = deps.locale === "es";
  if (name.length < 1 || name.length > 100) {
    return {
      response: NextResponse.json(
        { error: es ? "Introduce tu nombre." : "Please enter your name." },
        { status: 400 },
      ),
      tasks: [],
    };
  }

  const ipLimit = await consumeRateLimit(
    keyFor("signup:ip", clientIp(request)),
    AUTH_RATE_LIMITS.signupIp,
    "signup_ip",
  );
  if (!ipLimit.allowed) {
    return { response: tooManyAttempts(es, ipLimit.retryAfterSeconds), tasks: [] };
  }

  const emailLimit = await consumeRateLimit(
    keyFor("signup:email", email),
    AUTH_RATE_LIMITS.signupEmail,
    "signup_email",
  );
  if (!emailLimit.allowed) {
    return { response: tooManyAttempts(es, emailLimit.retryAfterSeconds), tasks: [] };
  }

  const mail = deps.mail();

  const [created] = await db.insert(users).values({
    name,
    email,
    passwordHash: PENDING_PASSWORD_HASH,
    role: "user",
    plan: "free",
  }).onConflictDoNothing({ target: users.email }).returning({
    id: users.id,
    email: users.email,
    name: users.name,
    emailVerifiedAt: users.emailVerifiedAt,
  });

  if (created) {
    return {
      response: NextResponse.json({ ok: true }),
      tasks: [claimTask(created, deps.locale, mail)],
    };
  }

  const [existing] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!existing) {
    return { response: NextResponse.json({ ok: true }), tasks: [] };
  }

  return {
    response: NextResponse.json({ ok: true }),
    tasks: [existing.emailVerifiedAt
      ? accountExistsTask(existing, deps.locale, mail)
      : claimTask(existing, deps.locale, mail)],
  };
}

async function handleLogin(
  request: Request,
  deps: AuthDeps,
  email: string,
  password: string,
): Promise<AuthOutcome> {
  const es = deps.locale === "es";
  const ip = clientIp(request);

  const ipLimit = await consumeRateLimit(
    keyFor("login:ip", ip),
    AUTH_RATE_LIMITS.loginIp,
    "login_ip",
  );
  if (!ipLimit.allowed) {
    return { response: tooManyAttempts(es, ipLimit.retryAfterSeconds), tasks: [] };
  }

  const ipFailureKey = keyFor("login:ip-failures", ip);
  const ipFailureState = await getRateLimitState(ipFailureKey);
  if (ipFailureState?.blockedUntil && ipFailureState.blockedUntil.getTime() > Date.now()) {
    return {
      response: tooManyAttempts(es, retryAfterSeconds(ipFailureState.blockedUntil)),
      tasks: [],
    };
  }

  const accountKey = keyFor("login:account", email);
  const outcome = await withEmailLock(email, async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const accountState = await getRateLimitStateTx(tx, accountKey);
    if (accountState?.blockedUntil && accountState.blockedUntil.getTime() > Date.now()) {
      return {
        kind: "blocked" as const,
        retryAfter: retryAfterSeconds(accountState.blockedUntil),
      };
    }

    const passwordMatches = await verifyPassword(
      password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches || !user.emailVerifiedAt) {
      await recordAuthFailureTx(tx, accountKey, ACCOUNT_FAILURE_BACKOFF);
      return { kind: "invalid" as const };
    }

    await clearAuthFailuresTx(tx, accountKey);
    const session = await createSessionInTransaction(tx, user.id);
    return { kind: "ok" as const, user, session };
  });

  if (outcome.kind === "blocked") {
    return { response: tooManyAttempts(es, outcome.retryAfter), tasks: [] };
  }

  if (outcome.kind === "invalid") {
    const ipFailure = await consumeRateLimit(
      ipFailureKey,
      AUTH_RATE_LIMITS.loginIpFailures,
      "login_ip_failures",
    );
    if (!ipFailure.allowed) {
      return { response: tooManyAttempts(es, ipFailure.retryAfterSeconds), tasks: [] };
    }
    return {
      response: NextResponse.json(
        {
          error: es
            ? "El correo o la contraseña son incorrectos."
            : "Email or password is incorrect.",
        },
        { status: 401 },
      ),
      tasks: [],
    };
  }

  return {
    response: sessionResponse(outcome.user.name, outcome.session.token, outcome.session.expiresAt),
    tasks: [],
  };
}

export async function handleAuth(request: Request, deps: AuthDeps): Promise<AuthOutcome> {
  const es = deps.locale === "es";
  let data: {
    mode?: unknown;
    email?: unknown;
    password?: unknown;
    name?: unknown;
  };
  try {
    data = await request.json() as typeof data;
  } catch {
    return {
      response: NextResponse.json(
        { error: es ? "Solicitud no válida." : "Invalid request." },
        { status: 400 },
      ),
      tasks: [],
    };
  }

  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const password = typeof data.password === "string" ? data.password : "";
  const name = typeof data.name === "string" ? data.name.trim() : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return {
      response: NextResponse.json(
        {
          error: es
            ? "Introduce un correo válido."
            : "Enter a valid email.",
        },
        { status: 400 },
      ),
      tasks: [],
    };
  }

  try {
    if (data.mode === "signup") {
      return await handleSignup(request, deps, email, name);
    }

    if (data.mode === "login") {
      if (password.length < 10 || password.length > 128) {
        return {
          response: NextResponse.json(
            {
              error: es
                ? "Introduce una contraseña de 10 a 128 caracteres."
                : "Enter a password of 10–128 characters.",
            },
            { status: 400 },
          ),
          tasks: [],
        };
      }
      return await handleLogin(request, deps, email, password);
    }

    return {
      response: NextResponse.json(
        { error: es ? "Solicitud no válida." : "Invalid request." },
        { status: 400 },
      ),
      tasks: [],
    };
  } catch (error) {
    if (error instanceof MailConfigurationError) {
      return {
        response: NextResponse.json(
          {
            error: es
              ? "El envío de correo aún no está configurado."
              : "Email delivery is not configured yet.",
          },
          { status: 503 },
        ),
        tasks: [],
      };
    }
    reportServerError("auth.request_failed", error);
    return {
      response: NextResponse.json(
        {
          error: es
            ? "No pudimos completar tu solicitud. Inténtalo de nuevo."
            : "Unable to complete your request. Please try again.",
        },
        { status: 500 },
      ),
      tasks: [],
    };
  }
}

export async function handleClaimRequest(
  request: Request,
  deps: AuthDeps,
): Promise<AuthOutcome> {
  const es = deps.locale === "es";
  let data: { email?: unknown };
  try {
    data = await request.json() as { email?: unknown };
  } catch {
    return {
      response: NextResponse.json({ error: es ? "Solicitud no válida." : "Invalid request." }, { status: 400 }),
      tasks: [],
    };
  }

  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { response: NextResponse.json({ ok: true }), tasks: [] };
  }

  const ipLimit = await consumeRateLimit(
    keyFor("verify-request:ip", clientIp(request)),
    AUTH_RATE_LIMITS.verifyRequestIp,
    "verify_request_ip",
  );
  if (!ipLimit.allowed) {
    return { response: tooManyAttempts(es, ipLimit.retryAfterSeconds), tasks: [] };
  }

  const emailLimit = await consumeRateLimit(
    keyFor("verify-request:email", email),
    AUTH_RATE_LIMITS.verifyRequestEmail,
    "verify_request_email",
  );
  if (!emailLimit.allowed) {
    return { response: tooManyAttempts(es, emailLimit.retryAfterSeconds), tasks: [] };
  }

  const mail = deps.mail();

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

  if (!user || user.emailVerifiedAt) {
    return { response: NextResponse.json({ ok: true }), tasks: [] };
  }

  return {
    response: NextResponse.json({ ok: true }),
    tasks: [claimTask(user, deps.locale, mail)],
  };
}

export async function handleClaim(request: Request, locale: Locale): Promise<Response> {
  const es = locale === "es";
  let data: { token?: unknown; password?: unknown };
  try {
    data = await request.json() as { token?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: es ? "Solicitud no válida." : "Invalid request." }, { status: 400 });
  }

  const token = typeof data.token === "string" ? data.token.trim() : "";
  const password = typeof data.password === "string" ? data.password : "";
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
    return NextResponse.json(
      { error: es ? "Este enlace no es válido." : "This link is invalid.", code: "invalid" },
      { status: 400 },
    );
  }
  if (password.length < 10 || password.length > 128) {
    return NextResponse.json(
      {
        error: es
          ? "Elige una contraseña de 10 a 128 caracteres."
          : "Choose a password of 10–128 characters.",
        code: "password",
      },
      { status: 400 },
    );
  }

  try {
    const ipLimit = await consumeRateLimit(
      keyFor("claim:ip", clientIp(request)),
      AUTH_RATE_LIMITS.claimIp,
      "claim_ip",
    );
    if (!ipLimit.allowed) return tooManyAttempts(es, ipLimit.retryAfterSeconds);

    const passwordHash = await hashPassword(password);
    const result = await claimAccountWithToken(token, passwordHash);

    if (result.status !== "claimed") {
      return NextResponse.json(
        {
          error: es
            ? "Este enlace no es válido, ya se usó o caducó."
            : "This link is invalid, already used, or expired.",
          code: result.status,
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    reportServerError("auth.claim_failed", error);
    return NextResponse.json(
      {
        error: es
          ? "No pudimos reclamar tu cuenta. Inténtalo de nuevo."
          : "We could not claim your account. Please try again.",
      },
      { status: 500 },
    );
  }
}
