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
  type BillingState,
  type DeletionBlocker,
  type PasswordFacts,
} from "@/lib/account-deletion";

export type ProfileDeps = {
  /** Test seams; production uses the real module imports above. */
  verify?: typeof verifyPassword;
  stripe?: ReturnType<typeof getStripe>;
  /**
   * The authenticated user. Same type as the production import, so a test can
   * pass a stale snapshot — which is the shape of the race in #144.
   */
  currentUser?: typeof currentUser;
  /** `getLocale()` reads Next's request-scoped cookies, so tests supply one. */
  locale?: "en" | "es";
  /** Reads the stored password hash; the route needs it to verify the password. */
  passwordHashFor?: (userId: string) => Promise<string>;
  /**
   * Deletes the account and returns the Stripe customer id found *at deletion
   * time* — not the caller's snapshot, which may predate a checkout linking one.
   *
   * Takes the provider billing check as an argument rather than closing over it:
   * the check must run *inside* the deletion transaction and under the per-user
   * lock, and only the transaction's owner can guarantee that (#144).
   */
  deleteUser?: (userId: string, assessProviderBilling: ProviderBillingCheck) => Promise<DeleteUserResult>;
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
  const user = await (deps.currentUser ?? currentUser)();
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const locale = deps.locale ?? await getLocale();
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
    matches = await (deps.verify ?? verifyPassword)(password, await (deps.passwordHashFor ?? passwordHashFor)(user.id));
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

  /*
   * Resolve Stripe BEFORE taking any lock. A missing Stripe is a 503
   * (`unverifiable`), and raising that inside a held advisory lock would block
   * this user's own checkout for the duration of the transaction for no reason.
   */
  const stripe = deps.stripe ?? getStripe();
  const remove = deps.deleteUser ?? defaultDeleteUser;

  /*
   * The gate and the delete are ONE serialised step (#144) — see
   * `defaultDeleteUser`. Assessing billing from the request's snapshot and then
   * deleting under the lock, in two separate transactions, left a window in
   * which a checkout could link a customer that the gate never saw.
   *
   * The Stripe check runs inside the transaction holding the per-user lock.
   * That is deliberate and bounded: `lock_timeout` stops a stuck session from
   * pinning this user's checkout, and the lock is per user, so one slow Stripe
   * response never delays anyone else.
   */
  const assessProviderBilling: ProviderBillingCheck = async (stripeCustomerId) => {
    if (!stripe) return "unverifiable";
    const result = await assessDeletionBilling(stripe, stripeCustomerId);
    if (result.state === "unverifiable") {
      log.error("profile.billing_check_failed", { ...requestMeta(request), userId: user.id, error: result.error });
    }
    return result.state;
  };

  let deleted: DeleteUserResult;
  try {
    deleted = await remove(user.id, assessProviderBilling);
  } catch (error) {
    log.error("profile.delete_failed", { ...requestMeta(request), userId: user.id, error });
    return NextResponse.json(
      { error: es ? "No pudimos eliminar tu cuenta." : "We could not delete your account." },
      { status: 500 },
    );
  }

  /*
   * Blocked by the gate *inside* the transaction: nothing was deleted, so this
   * is the same 409/503 the pre-lock version returned, minus the race.
   */
  if (deleted.kind === "blocked") {
    return NextResponse.json(blockedResponseBody(deleted.blocker, locale), { status: deleted.blocker.status });
  }

  const deletedCustomerId = deleted.customerId;

  /*
   * The account is gone; make sure billing is too.
   *
   * A checkout that authenticated before this request can still finish creating
   * a customer *after* the row above disappears. That leaves a Stripe customer
   * with a subscription pointing at a user that no longer exists, which the
   * webhook can only record as `webhook:unmapped`. Cancelling here is the one
   * action that actually stops the charge.
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
  if (deletedCustomerId && stripe) {
    const cleanup = await cancelBillingForDeletedAccount(stripe, deletedCustomerId);
    if (cleanup.cancelled) {
      log.info("profile.deletion_cancelled_billing", { ...requestMeta(request), userId: user.id });
    } else if (cleanup.reason !== "no_live_subscription") {
      log.error("profile.deletion_billing_cleanup_failed", {
        ...requestMeta(request), userId: user.id, customerId: deletedCustomerId, reason: cleanup.reason,
      });
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  return response;
}

/**
 * What a deletion attempt did. A union rather than a nullable id, because
 * "blocked by billing" and "deleted, no customer" are different answers and the
 * route must not have to infer one from the other.
 */
export type DeleteUserResult =
  | { kind: "deleted"; customerId: string | null }
  | { kind: "blocked"; blocker: DeletionBlocker };

/**
 * Stripe-side billing check, injected so the transaction can stay testable.
 *
 * Called only when the database has no live subscription for the user. There is
 * no default: a default would have to answer "clear", and a fail-open answer to
 * "is money moving?" is exactly the bug class this file exists to prevent.
 */
export type ProviderBillingCheck = (stripeCustomerId: string) => Promise<BillingState>;

/**
 * One transaction: lock, re-read, **gate**, audit row, delete — in that order.
 *
 * The gate lives inside the transaction on purpose (#144). Assessing billing
 * before taking the lock left a window: checkout takes the same lock to link a
 * customer, so a checkout that landed between the assessment and the delete was
 * invisible, and the account was deleted with a live subscription attached. The
 * only compensating action was a post-commit cancellation that can fail.
 *
 * With the gate under the lock, "is money moving?" and "delete" cannot be
 * separated by a customer link.
 *
 * `lock_timeout` / `statement_timeout` bound the lock: the Stripe calls run
 * inside it, so a socket that never answers would otherwise pin this user's
 * checkout and their next deletion attempt forever, holding a pooled connection
 * the whole time. Timing out is the safe failure — it rolls back, deletes
 * nothing, and returns 500 so the user retries.
 *
 * Exported so DB-gated tests drive this exact function. The ordering tests in
 * `tests/account-deletion.test.ts` substitute their own writer, so they cannot
 * see this file invert its own two statements around it — which is precisely
 * where the original bug lived. Only a real database can prove the pair this
 * file actually issues is accepted.
 */
export async function defaultDeleteUser(
  userId: string,
  assessProviderBilling: ProviderBillingCheck,
): Promise<DeleteUserResult> {
  return db.transaction(async tx => {
    /*
     * Serialise against checkout for this user (#144). Checkout takes the same
     * lock around customer creation and around its final survival check, so a
     * customer cannot be linked between this gate and this delete.
     */
    await tx.execute(sql`select set_config('lock_timeout', '5s', true)`);
    await tx.execute(sql`select set_config('statement_timeout', '20s', true)`);
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

    /*
     * The gate, also under the lock. The database answers first because it is
     * authoritative and free; Stripe is consulted only when the database has
     * nothing, because a checkout can complete before its webhook writes the
     * `subscriptions` row.
     */
    const [ongoing] = await tx
      .select({ id: subscriptions.stripeSubscriptionId })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ONGOING_SUBSCRIPTION_STATUSES)))
      .limit(1);

    let billing: BillingState = ongoing ? "ongoing" : "clear";
    if (billing === "clear" && current?.stripeCustomerId) {
      billing = await assessProviderBilling(current.stripeCustomerId);
    }

    const gate = assessBillingGate(billing);
    if (gate.kind === "blocked") return { kind: "blocked", blocker: gate.blocker };

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
    return { kind: "deleted", customerId: current?.stripeCustomerId ?? null };
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
