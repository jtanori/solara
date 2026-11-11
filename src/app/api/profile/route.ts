import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLogs, subscriptions, users } from "@/db/schema";
import { currentUser, SESSION_COOKIE } from "@/lib/auth";
import { getStripe } from "@/lib/billing";
import { getLocale } from "@/lib/i18n-server";
import { log, requestMeta } from "@/lib/log";
import { verifyPassword } from "@/lib/passwords";
import {
  accountDeletionAudit,
  assessBillingGate,
  assessDeletionGate,
  blockedResponseBody,
  type PasswordFacts,
} from "@/lib/account-deletion";

const ongoingStatuses = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

export type ProfileDeps = {
  /** Test seams; production uses the real module imports above. */
  verify?: typeof verifyPassword;
  stripe?: ReturnType<typeof getStripe>;
  deleteUser?: (userId: string) => Promise<void>;
};

export async function PATCH(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const data = await request.json().catch(() => null) as { name?: string } | null;
  const name = data?.name?.trim();
  if (!name || name.length > 100) return NextResponse.json({ error: "Enter a name of up to 100 characters." }, { status: 400 });
  await db.update(users).set({ name }).where(eq(users.id, user.id));
  return NextResponse.json({ ok: true });
}

/**
 * Delete the signed-in account.
 *
 * Gate order (see `lib/account-deletion.ts`): email verified → not an owner →
 * password present → password correct → no live subscription. The password is
 * checked before billing so a stolen session cannot use this endpoint to probe
 * subscription state or to expire open checkout sessions.
 *
 * The delete and its audit row share one transaction: a deletion without a
 * record is the gap this closes, and a record without the deletion would be a
 * lie.
 */
export async function DELETE(request: Request) {
  return deleteAccount(request);
}

/**
 * The handler body, with injectable seams. `DELETE` must keep Next's exact
 * `(request) => Response` signature — a second parameter fails route typegen —
 * so the testable form is a sibling function.
 */
export async function deleteAccount(request: Request, deps: ProfileDeps = {}) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const locale = await getLocale();
  const es = locale === "es";

  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";

  const passwordFacts: PasswordFacts = { submitted: password.length > 0, matches: null };
  let gate = assessDeletionGate({
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt),
    password: passwordFacts,
  });
  if (gate.kind === "blocked") {
    return NextResponse.json(blockedResponseBody(gate.blocker, locale), { status: gate.blocker.status });
  }

  // Only now do we pay for scrypt. A request without a password never hashes.
  let matches: boolean;
  try {
    matches = await (deps.verify ?? verifyPassword)(password, await passwordHashFor(user.id));
  } catch (error) {
    // A hashing-capacity failure is a 503, not a wrong password.
    log.error("profile.delete_password_check_failed", { ...requestMeta(request), userId: user.id, error });
    return NextResponse.json(
      { error: es ? "El servicio está ocupado. Inténtalo de nuevo en un momento." : "The service is busy. Please try again shortly." },
      { status: 503 },
    );
  }

  passwordFacts.matches = matches;
  gate = assessDeletionGate({
    role: user.role,
    emailVerified: Boolean(user.emailVerifiedAt),
    password: passwordFacts,
  });
  if (gate.kind === "blocked") {
    // Do not log the attempt as an error: a mistyped password is not an incident,
    // and logging it would make a stolen session's probing noisier than its
    // successes.
    return NextResponse.json(blockedResponseBody(gate.blocker, locale), { status: gate.blocker.status });
  }

  const [ongoing] = await db
    .select({ id: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, ongoingStatuses)))
    .limit(1);

  let billing: "clear" | "ongoing" | "unverifiable" = ongoing ? "ongoing" : "clear";

  // Check Stripe as well, because a checkout could have completed before its
  // webhook arrived.
  if (billing === "clear" && user.stripeCustomerId) {
    const stripe = deps.stripe ?? getStripe();
    if (!stripe) {
      billing = "unverifiable";
    } else {
      try {
        const hasOngoing = async () => {
          const list = await stripe.subscriptions.list({ customer: user.stripeCustomerId!, status: "all", limit: 100 });
          return list.data.some(subscription => ongoingStatuses.includes(subscription.status));
        };
        if (await hasOngoing()) {
          billing = "ongoing";
        } else {
          const sessions = await stripe.checkout.sessions.list({ customer: user.stripeCustomerId, status: "open", limit: 100 });
          for (const session of sessions.data) {
            if (session.mode === "subscription") await stripe.checkout.sessions.expire(session.id);
          }
          if (await hasOngoing()) billing = "ongoing";
        }
      } catch (error) {
        log.error("profile.billing_check_failed", { ...requestMeta(request), userId: user.id, error });
        billing = "unverifiable";
      }
    }
  }

  const billingGate = assessBillingGate(billing);
  if (billingGate.kind === "blocked") {
    return NextResponse.json(blockedResponseBody(billingGate.blocker, locale), { status: billingGate.blocker.status });
  }

  try {
    const remove = deps.deleteUser ?? (async (userId: string) => {
      await db.transaction(async tx => {
        await tx.delete(users).where(eq(users.id, userId));
        // Same transaction: the audit row survives the cascade because
        // audit_logs.actor_id is `on delete set null`, while `target` keeps the id.
        await tx.insert(auditLogs).values(accountDeletionAudit(userId));
      });
    });
    await remove(user.id);
  } catch (error) {
    log.error("profile.delete_failed", { ...requestMeta(request), userId: user.id, error });
    return NextResponse.json(
      { error: es ? "No pudimos eliminar tu cuenta." : "We could not delete your account." },
      { status: 500 },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  return response;
}

/**
 * `currentUser()` deliberately does not carry `passwordHash` — it is not part of
 * the identity it returns, and nothing else should be able to read it. Deletion
 * fetches it here, for this one purpose.
 */
async function passwordHashFor(userId: string): Promise<string> {
  const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.passwordHash ?? "";
}
