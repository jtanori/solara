import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLogs, deletedCustomers, subscriptions, users } from "@/db/schema";
import { currentUser, SESSION_COOKIE } from "@/lib/auth";
import { getStripe } from "@/lib/billing";
import {
  assessDeletionBilling,
  cancelBillingForDeletedAccount,
  ONGOING_SUBSCRIPTION_STATUSES,
  type DeletionBillingResult,
  type DeletionBillingStripe,
  type DeletionCleanupStripe,
} from "@/lib/billing-state";
import { getLocale } from "@/lib/i18n-server";
import { withDeadline } from "@/lib/readiness";
import { log, requestMeta } from "@/lib/log";
import { verifyPassword } from "@/lib/passwords";
import {
  accountDeletionCustomerAudit,
  assessBillingGate,
  deletedCustomerAssociation,
  assessDeletionGate,
  blockedResponseBody,
  writeAccountDeletion,
  type BillingState,
  type DeletionBlocker,
  type PasswordFacts,
} from "@/lib/account-deletion";

/**
 * How long the deletion may spend on the provider check while holding the
 * per-user lock. Shorter than the transaction's `statement_timeout` (20s) so the
 * deadline is what ends a stalled call, with the SQL timeout as a backstop.
 */
export const PROVIDER_BILLING_DEADLINE_MS = 8_000;

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
  /*
   * The check runs while the deletion transaction holds the per-user advisory
   * lock, so its duration is the lock's duration. `lock_timeout` and
   * `statement_timeout` cannot help here: they bound SQL, and this awaits HTTP.
   * A Stripe socket that never answers would therefore hold the lock and a pool
   * connection indefinitely while the database sat idle.
   *
   * `withDeadline` bounds the wait. It does NOT cancel the underlying request —
   * fetch keeps running until the runtime's own timeout — so this bounds the
   * lock, not the socket, and that distinction is the point.
   *
   * `unverifiable` is written even if the deadline is what fired, so a slow
   * provider still fails closed and still blocks the deletion.
   */
  const assessProviderBilling: ProviderBillingCheck = async (stripeCustomerId) => {
    const expireSessions = async (sessionIds: string[]) => {
      if (!stripe) return;
      for (const sessionId of sessionIds) {
        // A session that vanished, expired already, or was paid is not a reason
        // to fail a deletion; a completed checkout of a deleted account is what
        // the webhook handles. Logged with the id so it is findable.
        await stripe.checkout.sessions.expire(sessionId).catch(error => {
          log.error("profile.checkout_session_expire_failed", { userId: user.id, sessionId, error });
        });
      }
    };
    if (!stripe) return { state: "unverifiable", error: new Error("stripe_not_configured"), expireSessions };

    /*
     * A deadline alone does not stop work: `withDeadline` races promises, so the
     * underlying list/expire calls would keep running after this returns and the
     * transaction commits — with the lock released. A slow list could then expire
     * a session a *new* checkout had just created.
     *
     * Two changes close that:
     *   1. `assessDeletionBilling` is read-only (it reports sessions, expires
     *      nothing), so an abandoned check cannot mutate anything.
     *   2. This wrapper stops *reading* too: once the deadline fires, a guard the
     *      check consults between calls makes every later Stripe call a no-op, so
     *      no further request is issued and no page walk continues.
     */
    let expired = false;
    const guarded = abortionGuardedStripe(stripe, () => expired);
    const result = await withDeadline(
      assessDeletionBilling(guarded, stripeCustomerId),
      PROVIDER_BILLING_DEADLINE_MS,
      "provider_billing_deadline_exceeded",
    ).catch(error => {
      expired = true;
      return { state: "unverifiable" as const, error };
    });
    if (result.state === "unverifiable") {
      log.error("profile.billing_check_failed", { ...requestMeta(request), userId: user.id, error: result.error });
    }
    return { ...result, expireSessions };
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
    /*
     * Per-subscription and attributed — never `customers.del`. Deleting the
     * customer would cancel every subscription on it, including another
     * product's on a shared Stripe account, and nothing in the evidence can tell
     * whose they were.
     */
    const cleanup = await cancelBillingForDeletedAccount(
      deletionCleanupStripe(stripe),
      deletedCustomerId,
      user.id,
    );
    if (cleanup.cancelled) {
      log.info("profile.deletion_cancelled_billing", {
        ...requestMeta(request), userId: user.id, cancelled: cleanup.cancelledIds,
      });
    } else if (cleanup.reason !== "no_live_subscription") {
      log.error("profile.deletion_billing_cleanup_failed", {
        ...requestMeta(request), userId: user.id, customerId: deletedCustomerId, reason: cleanup.reason,
      });
    }
    /*
     * Subscriptions on this customer that could not be attributed to the deleted
     * account are left alone on purpose and reported individually: cancelling
     * them is exactly the shared-account mistake, and the webhook quarantines
     * them as `webhook:unmapped` for a human when they next emit an event.
     */
    if (cleanup.unattributed.length > 0) {
      log.error("profile.deletion_billing_unattributed", {
        ...requestMeta(request), userId: user.id, customerId: deletedCustomerId, subscriptionIds: cleanup.unattributed,
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
 *
 * Returns the whole result rather than just the state, because `clear` carries
 * the open checkout sessions that must be expired — and they are expired by the
 * caller, inside the transaction that holds the lock. See `defaultDeleteUser`.
 */
export type ProviderBillingCheck = (stripeCustomerId: string) => Promise<ProviderBillingAssessment>;

/**
 * The assessment plus the one *action* the transaction is allowed to take.
 *
 * Expiry is a mutation, so it is passed in as a capability rather than the
 * transaction reaching for the Stripe client: the deletion code stays testable,
 * and it is obvious in the type that this is the only write the gate can cause.
 * It must be called while the lock is held — see `defaultDeleteUser`.
 */
export type ProviderBillingAssessment = DeletionBillingResult & {
  expireSessions: (sessionIds: string[]) => Promise<void>;
};

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
  /**
   * Captured from the assessment, then used *after* the gate passes and still
   * inside this transaction — the only write the gate can cause.
   */
  let expireSessions: ProviderBillingAssessment["expireSessions"] | undefined;
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
    let openSessionIds: string[] = [];
    if (billing === "clear" && current?.stripeCustomerId) {
      const assessed = await assessProviderBilling(current.stripeCustomerId);
      billing = assessed.state;
      expireSessions = assessed.expireSessions;
      if (assessed.state === "clear") openSessionIds = assessed.openSessionIds;
    }

    const gate = assessBillingGate(billing);
    if (gate.kind === "blocked") return { kind: "blocked", blocker: gate.blocker };

    /*
     * Expire the open checkouts HERE, not in the assessment (#142 review).
     *
     * The assessment runs under a deadline; anything it did after that deadline
     * would run with the lock released and could expire a session a newer checkout
     * had just created. Expiry belongs to the step that is still holding the lock,
     * so it cannot race a checkout that follows. It is also last: if this throws,
     * nothing has been deleted yet.
     */
    if (openSessionIds.length > 0 && expireSessions) {
      await expireSessions(openSessionIds);
    }

    await writeAccountDeletion({
      insertAudit: async (row) => {
        await tx.insert(auditLogs).values(row);
        // Second row keyed by the customer id, so the webhook can prove deletion
        // even when a subscription's metadata has lost `solara_user_id`.
        if (current?.stripeCustomerId) {
          await tx.insert(auditLogs).values(accountDeletionCustomerAudit(userId, current.stripeCustomerId));
          /*
           * The pairing, explicitly. Two audit rows cannot prove they came from
           * the same deletion, which is what the webhook needs to attribute a
           * subscription; this row can. `onConflictDoNothing` because a
           * redelivered deletion for the same customer must not fail.
           */
          await tx
            .insert(deletedCustomers)
            .values(deletedCustomerAssociation(userId, current.stripeCustomerId))
            .onConflictDoNothing();
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
 * Wraps the pricing/gate Stripe client so that once `isAborted()` turns true, no
 * further request is issued.
 *
 * The point is not to save work — it is to stop a check whose deadline already
 * fired from mutating Stripe later, when the lock it was holding is gone. Each
 * call re-checks, so a page walk that is between pages stops rather than running
 * to completion after the caller has already answered.
 */
function abortionGuardedStripe(
  stripe: NonNullable<ReturnType<typeof getStripe>>,
  isAborted: () => boolean,
): DeletionBillingStripe {
  const abortIfExpired = () => {
    if (isAborted()) throw new Error("provider_billing_deadline_exceeded");
  };
  return {
    subscriptions: {
      list: async params => {
        abortIfExpired();
        return stripe.subscriptions.list({
          customer: params.customer,
          status: params.status,
          limit: params.limit,
          ...(params.starting_after ? { starting_after: params.starting_after } : {}),
        });
      },
    },
    checkout: {
      sessions: {
        list: async params => {
          abortIfExpired();
          return stripe.checkout.sessions.list({
            customer: params.customer,
            status: params.status,
            limit: params.limit,
            ...(params.starting_after ? { starting_after: params.starting_after } : {}),
          });
        },
      },
    },
  };
}

/**
 * Adapts the Stripe client to the narrow port `cancelBillingForDeletedAccount`
 * uses, so the decision stays testable without a real client and the readings of
 * `priceId` / `metadata.solara_user_id` happen in exactly one place.
 */
function deletionCleanupStripe(stripe: NonNullable<ReturnType<typeof getStripe>>): DeletionCleanupStripe {
  return {
    subscriptions: {
      list: async params => {
        const page = await stripe.subscriptions.list({
          customer: params.customer,
          status: "all",
          limit: params.limit,
          ...(params.starting_after ? { starting_after: params.starting_after } : {}),
        });
        return {
          has_more: page.has_more,
          data: page.data.map(subscription => ({
            id: subscription.id,
            status: subscription.status,
            priceId: subscription.items.data[0]?.price.id ?? null,
            metadataUserId: subscription.metadata?.solara_user_id ?? null,
          })),
        };
      },
      cancel: async id => stripe.subscriptions.cancel(id),
    },
    customers: {
      retrieve: async id => {
        const customer = await stripe.customers.retrieve(id);
        if (customer.deleted) return null;
        return { metadataUserId: customer.metadata?.solara_user_id ?? null };
      },
    },
  };
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
