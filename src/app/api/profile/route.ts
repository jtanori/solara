import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLogs, subscriptions, users } from "@/db/schema";
import { currentUser, SESSION_COOKIE } from "@/lib/auth";
import { getStripe } from "@/lib/billing";
import { assessDeletionBilling, cancelBillingForDeletedAccount, ONGOING_SUBSCRIPTION_STATUSES } from "@/lib/billing-state";
import { getLocale } from "@/lib/i18n-server";
import { log, requestMeta } from "@/lib/log";
import { verifyPassword } from "@/lib/passwords";
import {
  accountDeletionCustomerAudit,
  assessBillingGate,
  assessDeletionGate,
  blockedResponseBody,
  writeAccountDeletion,
  type PasswordFacts,
} from "@/lib/account-deletion";

export type ProfileDeps = {
  /** Test seams; production uses the real module imports above. */
  verify?: typeof verifyPassword;
  stripe?: ReturnType<typeof getStripe>;
  /**
   * Deletes the account and returns the Stripe customer id found *at deletion
   * time* — not the caller's snapshot, which may predate a checkout linking one.
   */
  deleteUser?: (userId: string) => Promise<string | null>;
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
    .where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, ONGOING_SUBSCRIPTION_STATUSES)))
    .limit(1);

  let billing: "clear" | "ongoing" | "unverifiable" = ongoing ? "ongoing" : "clear";

  // Check Stripe as well, because a checkout could have completed before its
  // webhook arrived.
  if (billing === "clear" && user.stripeCustomerId) {
    const stripe = deps.stripe ?? getStripe();
    if (!stripe) {
      billing = "unverifiable";
    } else {
      // Every page is walked, and any failure fails closed — see
      // `assessDeletionBilling`, which is also what the tests drive.
      const result = await assessDeletionBilling(stripe, user.stripeCustomerId);
      if (result.state === "unverifiable") {
        log.error("profile.billing_check_failed", { ...requestMeta(request), userId: user.id, error: result.error });
      }
      billing = result.state;
    }
  }

  const billingGate = assessBillingGate(billing);
  if (billingGate.kind === "blocked") {
    return NextResponse.json(blockedResponseBody(billingGate.blocker, locale), { status: billingGate.blocker.status });
  }

  let deletedCustomerId: string | null = null;
  try {
    const remove = deps.deleteUser ?? defaultDeleteUser;
    deletedCustomerId = await remove(user.id);
  } catch (error) {
    log.error("profile.delete_failed", { ...requestMeta(request), userId: user.id, error });
    return NextResponse.json(
      { error: es ? "No pudimos eliminar tu cuenta." : "We could not delete your account." },
      { status: 500 },
    );
  }

  /*
   * The account is gone; make sure billing is too.
   *
   * A checkout that authenticated before this request can still finish creating
   * a customer *after* the row above disappears — the race in #144. That leaves
   * a Stripe customer with a subscription pointing at a user that no longer
   * exists, which the webhook can only record as `webhook:unmapped`. Cancelling
   * here is the one action that actually stops the charge.
   *
   * A failure must not fail the request: the account is already deleted, and
   * returning an error would tell the user it was not. It is logged with the
   * data support needs to chase it.
   */
  /*
   * `deletedCustomerId` comes from inside the deletion transaction, not from the
   * snapshot read at the start of the request. A checkout that linked a customer
   * while this request waited would be missing from the snapshot, and skipping
   * cleanup in that case leaves a paid subscription with no account.
   */
  if (deletedCustomerId) {
    const stripe = deps.stripe ?? getStripe();
    if (stripe) {
      const cleanup = await cancelBillingForDeletedAccount(stripe, deletedCustomerId);
      if (cleanup.cancelled) {
        log.info("profile.deletion_cancelled_billing", { ...requestMeta(request), userId: user.id });
      } else if (cleanup.reason !== "no_live_subscription") {
        log.error("profile.deletion_billing_cleanup_failed", {
          ...requestMeta(request), userId: user.id, customerId: deletedCustomerId, reason: cleanup.reason,
        });
      }
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  return response;
}

/**
 * One transaction, so a deletion without a record stays impossible. The order
 * inside it lives in `writeAccountDeletion`: audit row first, delete second.
 * Written the other way round (delete, then insert) the audit row's foreign key
 * has nothing to reference and Postgres aborts with `23503`.
 *
 * Exported so the DB-gated test in `tests/profile-deletion.test.ts` can drive
 * this exact function. The ordering tests in `tests/account-deletion.test.ts`
 * prove `writeAccountDeletion` is called in the right order, but they substitute
 * their own writer — so they cannot see this file invert its own two statements
 * around it, which is precisely where the bug lived. Only a real database can
 * prove the pair this file actually issues is accepted.
 */
export async function defaultDeleteUser(userId: string): Promise<string | null> {
  return db.transaction(async tx => {
    /*
     * Serialise against checkout for this user (#144). Checkout takes the same
     * lock around customer creation and session creation; holding it here from
     * the re-read through the delete is what stops a customer being attached at
     * the last moment.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`account-deletion:${userId}`}))`);

    /*
     * Re-read the customer id UNDER the lock. The route's snapshot was taken
     * before checkout could have linked one: a checkout that completed while we
     * waited would otherwise be invisible, the deletion would skip cleanup, and
     * a paid subscription would outlive the account with nothing cancelling it.
     */
    const [current] = await tx
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    await writeAccountDeletion({
      insertAudit: async (row) => {
        await tx.insert(auditLogs).values(row);
        // Second row keyed by the customer id, so the webhook can prove deletion
        // even when a subscription's metadata has lost `solara_user_id`.
        if (current?.stripeCustomerId) {
          await tx.insert(auditLogs).values(accountDeletionCustomerAudit(userId, current.stripeCustomerId));
        }
      },
      deleteUser: async (id) => {
        await tx.delete(users).where(eq(users.id, id));
      },
    }, userId);

    // Hand the id back so the caller cleans up without trusting its snapshot.
    return current?.stripeCustomerId ?? null;
  });
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
