import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLogs, deletedCustomers, subscriptions, users } from "@/db/schema";
import {
  CoordinationPoolUnavailable,
  LifecycleLeaseLost,
  LifecycleLeaseTimeout,
  withAccountLifecycleLock,
} from "@/lib/account-lifecycle-lock";
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
 * per-user lease. The final transaction has its own, shorter statement timeout
 * and holds no provider I/O.
 */
export const PROVIDER_BILLING_DEADLINE_MS = 8_000;

/** Refuse to delete while this many open checkout sessions remain. */
export const MAX_EXPIRY_SESSIONS = 100;

/** Bound the expiry phase; the lease is not released until an in-flight call settles. */
export const EXPIRY_DEADLINE_MS = 20_000;

/** Must stay below the app pool's 15s query_timeout. */
export const FINAL_DELETE_STATEMENT_TIMEOUT_MS = 14_000;

/**
 * A provider interaction that cannot prove the account is clear of money.
 * Mapped to 503 so the user retries instead of deleting a payable account.
 */
class BillingStateError extends Error {
  readonly code = "billing_unverifiable";
  constructor() {
    super("billing_unverifiable");
    this.name = "BillingStateError";
  }
}

/** Drizzle wraps driver errors, so the SQLSTATE is usually on `cause`. */
function databaseErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return cause?.code ?? (error as { code?: string })?.code;
}

function isRetryableDatabaseTimeout(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return code === "55P03" || code === "57014";
}

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
   * the check must run *under* the per-user lease, and only the lease owner can
   * guarantee that (#144).
   */
  deleteUser?: (userId: string, assessProviderBilling: ProviderBillingCheck, deps?: DeleteUserDeps) => Promise<DeleteUserResult>;
  /** Tests inject a dedicated coordination pool through this seam. */
  lifecycleLock?: typeof withAccountLifecycleLock;
  /** Test seams for the bounded expiry phase. */
  expiryDeadlineMs?: number;
  maxExpirySessions?: number;
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
   * Resolve Stripe BEFORE taking the lease. A missing Stripe is a 503
   * (`unverifiable`), and raising that inside a held lease would block this
   * user's own checkout for no reason.
   */
  const stripe = deps.stripe ?? getStripe();
  const remove = deps.deleteUser ?? defaultDeleteUser;

  /*
   * The gate and the delete are ONE serialised step (#144) — see
   * `defaultDeleteUser`. The Stripe check runs while the deletion holds the
   * per-user lifecycle lease; lease queries use the app pool, while the optional
   * compatibility advisory lock uses the separate coordination pool. A slow
   * provider therefore delays this user's own lifecycle work, not the app pool.
   *
   * `withDeadline` bounds the wait. It does NOT cancel the underlying request —
   * fetch keeps running until the runtime's own timeout — so this bounds the
   * lease, not the socket, and that distinction is the point.
   *
   * `unverifiable` is written even if the deadline is what fired, so a slow
   * provider still fails closed and still blocks the deletion.
   */
  const assessProviderBilling: ProviderBillingCheck = async (stripeCustomerId) => {
    const expireSessions = async (
      sessionIds: string[],
      signal?: AbortSignal,
      assertLease?: () => Promise<void>,
    ) => {
      if (!stripe) throw new BillingStateError();
      for (const sessionId of sessionIds) {
        if (signal?.aborted) throw new BillingStateError();
        /*
         * Check before the write, not only in the final transaction. If the
         * heartbeat failed or another owner took over, do not start a new
         * Stripe mutation. The in-flight call is inherently uncancellable; this
         * narrows the window instead of claiming it does not exist.
         */
        await assertLease?.();
        try {
          await stripe.checkout.sessions.expire(sessionId);
        } catch (error) {
          // Already gone is success. Anything else means we cannot prove the
          // session is no longer payable, so fail closed instead of deleting.
          if (isGoneCheckoutSession(error)) continue;
          if (isCheckoutSessionNotOpen(error)) {
            const status = await checkoutSessionStatus(stripe, sessionId);
            if (status === "expired") continue;
            log.error("profile.checkout_session_not_open", {
              ...requestMeta(request),
              userId: user.id,
              sessionId,
              status: status ?? "unknown",
            });
            throw new BillingStateError();
          }
          log.error("profile.checkout_session_expire_failed", {
            ...requestMeta(request),
            userId: user.id,
            sessionId,
            code: (error as { code?: string }).code ?? "unknown",
          });
          throw new BillingStateError();
        }
        /*
         * If the lease was lost while this call was in flight, stop before the
         * next session. The write that already completed cannot be undone, but
         * no further sessions are touched after a takeover.
         */
        await assertLease?.();
      }
    };
    if (!stripe) return { state: "unverifiable", error: new Error("stripe_not_configured"), expireSessions };

    /*
     * A deadline alone does not stop work: `withDeadline` races promises, so the
     * underlying list/expire calls would keep running after this returns — with
     * the lease released. A slow list could then expire a session a *new* checkout
     * had just created.
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
    deleted = await remove(user.id, assessProviderBilling, {
      lifecycleLock: deps.lifecycleLock,
      expiryDeadlineMs: deps.expiryDeadlineMs,
      maxExpirySessions: deps.maxExpirySessions,
    });
  } catch (error) {
    if (error instanceof BillingStateError) {
      const blocked = assessBillingGate("unverifiable");
      if (blocked.kind === "blocked") {
        return NextResponse.json(blockedResponseBody(blocked.blocker, locale), { status: blocked.blocker.status });
      }
    }
    if (error instanceof LifecycleLeaseTimeout || error instanceof LifecycleLeaseLost || error instanceof CoordinationPoolUnavailable || isRetryableDatabaseTimeout(error)) {
      log.error("profile.delete_coordination_unavailable", {
        ...requestMeta(request),
        userId: user.id,
        code: databaseErrorCode(error) ?? (error instanceof Error ? error.name : "unknown"),
      });
      return NextResponse.json(
        { error: es ? "El servicio está ocupado. Inténtalo de nuevo en un momento." : "The service is busy. Please try again shortly." },
        { status: 503 },
      );
    }
    log.error("profile.delete_failed", { ...requestMeta(request), userId: user.id, error });
    return NextResponse.json(
      { error: es ? "No pudimos eliminar tu cuenta." : "We could not delete your account." },
      { status: 500 },
    );
  }

  if (deleted.kind === "gone") {
    const response = NextResponse.json({ error: es ? "Inicia sesión primero." : "Please sign in first." }, { status: 401 });
    response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return response;
  }

  /*
   * Blocked by the gate *under* the lease: nothing was deleted, so this is the
   * same 409/503 the pre-lease version returned, minus the race.
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
  | { kind: "blocked"; blocker: DeletionBlocker }
  | { kind: "gone" };

export type DeleteUserDeps = {
  lifecycleLock?: typeof withAccountLifecycleLock;
  expiryDeadlineMs?: number;
  maxExpirySessions?: number;
};

/**
 * Stripe-side billing check, injected so the leased path can stay testable.
 *
 * Called only when the database has no live subscription for the user. There is
 * no default: a default would have to answer "clear", and a fail-open answer to
 * "is money moving?" is exactly the bug class this file exists to prevent.
 *
 * Returns the whole result rather than just the state, because `clear` carries
 * the open checkout sessions that must be expired — and they are expired by the
 * caller, while the lifecycle lease is held. See `defaultDeleteUser`.
 */
export type ProviderBillingCheck = (stripeCustomerId: string) => Promise<ProviderBillingAssessment>;

/**
 * The assessment plus the one *action* the leased path is allowed to take.
 *
 * Expiry is a mutation, so it is passed in as a capability rather than the
 * deletion code reaching for the Stripe client: the code stays testable, and it
 * is obvious in the type that this is the only write the gate can cause. It
 * must be called while the lifecycle lease is held — see `defaultDeleteUser`.
 */
export type ProviderBillingAssessment = DeletionBillingResult & {
  expireSessions: (
    sessionIds: string[],
    signal?: AbortSignal,
    /**
     * Re-checks the lease immediately before and after each provider mutation.
     * A session expiry is a Stripe write; a lease that was lost or taken over
     * must stop the next write even though the final database fence comes later.
     */
    assertLease?: () => Promise<void>,
  ) => Promise<void>;
};

/**
 * Lock, re-read, **gate**, then one short write transaction: audit row, association,
 * delete — in that order.
 *
 * The gate lives under the lifecycle lease on purpose (#144). Checkout takes the
 * same lease to link a customer, so a link landing between the assessment and the
 * delete cannot be invisible. The provider assessment is read-only and runs on
 * the app pool, not inside a database transaction; the final `FOR UPDATE`
 * transaction fences the lease, re-reads role, verification and customer id
 * before writing, and holds no Stripe I/O.
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
  deps: DeleteUserDeps = {},
): Promise<DeleteUserResult> {
  const withLock = deps.lifecycleLock ?? withAccountLifecycleLock;
  const maxExpirySessions = deps.maxExpirySessions ?? MAX_EXPIRY_SESSIONS;
  const expiryDeadlineMs = deps.expiryDeadlineMs ?? EXPIRY_DEADLINE_MS;
  return withLock(userId, async (clientDb, lease) => {
    /*
     * Read the current identity UNDER the lease. The route's snapshot predates
     * a checkout that may have linked a customer while this request waited.
     */
    const [current] = await clientDb
      .select({ role: users.role, emailVerifiedAt: users.emailVerifiedAt, stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!current) return { kind: "gone" } as const;

    const currentGate = assessDeletionGate({
      role: current.role,
      emailVerified: Boolean(current.emailVerifiedAt),
      password: { submitted: true, matches: true },
    });
    if (currentGate.kind === "blocked") return { kind: "blocked", blocker: currentGate.blocker } as const;

    /*
     * The database answers first because it is authoritative and free; Stripe is
     * consulted only when the database has nothing, because a checkout can
     * complete before its webhook writes the `subscriptions` row.
     */
    const [ongoing] = await clientDb
      .select({ id: subscriptions.stripeSubscriptionId })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ONGOING_SUBSCRIPTION_STATUSES)))
      .limit(1);

    let billing: BillingState = ongoing ? "ongoing" : "clear";
    let openSessionIds: string[] = [];
    let expireSessions: ProviderBillingAssessment["expireSessions"] | undefined;
    if (billing === "clear" && current.stripeCustomerId) {
      const assessed = await assessProviderBilling(current.stripeCustomerId);
      billing = assessed.state;
      expireSessions = assessed.expireSessions;
      if (assessed.state === "clear") openSessionIds = assessed.openSessionIds;
    }

    const gate = assessBillingGate(billing);
    if (gate.kind === "blocked") return { kind: "blocked", blocker: gate.blocker } as const;

    if (openSessionIds.length > maxExpirySessions) {
      log.error("profile.checkout_session_expiry_cap", {
        userId,
        count: openSessionIds.length,
        max: maxExpirySessions,
      });
      throw new BillingStateError();
    }

    /*
     * Expire open checkouts while the lifecycle lease is held. The assessment is
     * read-only and deadline-bounded; expiry is the mutating step, and a failure
     * here fails closed before anything is deleted. If the deadline fires, wait
     * for the in-flight Stripe call before releasing the lease: returning while
     * an expiry is still running would let it mutate after the lease is gone.
     */
    if (openSessionIds.length > 0 && expireSessions) {
      const assertLease = async () => {
        if (lease.isLost()) throw new LifecycleLeaseLost();
        await lease.assertHeld(clientDb);
      };
      /*
       * Do not begin the mutating phase on an expired/taken-over lease. The
       * assessment is read-only, so this is the first point where a lost lease
       * could otherwise still cause a Stripe write.
       */
      await assertLease();
      const controller = new AbortController();
      const expiry = expireSessions(openSessionIds, controller.signal, assertLease);
      try {
        await withDeadline(expiry, expiryDeadlineMs, "checkout_session_expiry_deadline_exceeded");
      } catch (error) {
        controller.abort();
        await expiry.catch(() => undefined);
        throw error instanceof BillingStateError || error instanceof LifecycleLeaseLost
          ? error
          : new BillingStateError();
      }
    }

    /*
     * One short write transaction. It holds no Stripe I/O, fences the lease,
     * then re-reads the row with FOR UPDATE so a role change or webhook customer
     * link cannot land between the gate and the delete. The lease row is locked
     * first; checkout takes the same order.
     */
    await lease.stopHeartbeat();
    return clientDb.transaction(async tx => {
      await tx.execute(sql`select set_config('lock_timeout', '5s', true)`);
      await tx.execute(sql`select set_config('statement_timeout', ${`${FINAL_DELETE_STATEMENT_TIMEOUT_MS}ms`}, true)`);
      await lease.assertHeld(tx);

      const [locked] = await tx
        .select({ role: users.role, emailVerifiedAt: users.emailVerifiedAt, stripeCustomerId: users.stripeCustomerId })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!locked) return { kind: "gone" } as const;

      const finalGate = assessDeletionGate({
        role: locked.role,
        emailVerified: Boolean(locked.emailVerifiedAt),
        password: { submitted: true, matches: true },
      });
      if (finalGate.kind === "blocked") return { kind: "blocked", blocker: finalGate.blocker } as const;

      if (locked.stripeCustomerId !== current.stripeCustomerId) {
        const blocked = assessBillingGate("unverifiable");
        if (blocked.kind === "blocked") return { kind: "blocked", blocker: blocked.blocker } as const;
      }

      const [finalOngoing] = await tx
        .select({ id: subscriptions.stripeSubscriptionId })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ONGOING_SUBSCRIPTION_STATUSES)))
        .limit(1);
      if (finalOngoing) {
        const blocked = assessBillingGate("ongoing");
        if (blocked.kind === "blocked") return { kind: "blocked", blocker: blocked.blocker } as const;
      }

      await writeAccountDeletion({
        insertAudit: async (row) => {
          await tx.insert(auditLogs).values(row);
          // Second row keyed by the customer id, so the webhook can prove deletion
          // even when a subscription's metadata has lost `solara_user_id`.
          if (locked.stripeCustomerId) {
            await tx.insert(auditLogs).values(accountDeletionCustomerAudit(userId, locked.stripeCustomerId));
            /*
             * The pairing, explicitly. Two audit rows cannot prove they came from
             * the same deletion, which is what the webhook needs to attribute a
             * subscription; this row can. `onConflictDoNothing` because a
             * redelivered deletion for the same customer must not fail.
             */
            await tx
              .insert(deletedCustomers)
              .values(deletedCustomerAssociation(userId, locked.stripeCustomerId))
              .onConflictDoNothing();
          }
        },
        deleteUser: async (id) => {
          await tx.delete(users).where(eq(users.id, id));
        },
      }, userId);

      // Hand the id back so the caller cleans up without trusting its snapshot.
      return { kind: "deleted", customerId: locked.stripeCustomerId ?? null } as const;
    });
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
 * A vanished or already-expired checkout session is already unpaid.
 *
 * A bare 404 is not enough: a proxy, a misrouted request, or a malformed API
 * response can synthesize one without proving the Stripe resource is gone. Require
 * Stripe's resource-missing code or an explicit "already expired" response.
 */
function isGoneCheckoutSession(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;
  const code = (error as { code?: string })?.code;
  const message = String((error as { message?: string })?.message ?? "");
  return code === "resource_missing" || (status === 400 && /already (been )?expired/i.test(message));
}

/**
 * Stripe refuses to expire a session that is no longer open. That refusal is not
 * enough to proceed: the session could be `open` on another page or `complete`
 * and payable. Read it back and only treat `expired` as settled.
 */
function isCheckoutSessionNotOpen(error: unknown): boolean {
  return (error as { code?: string })?.code === "checkout_session_not_open";
}

async function checkoutSessionStatus(
  stripe: NonNullable<ReturnType<typeof getStripe>>,
  sessionId: string,
): Promise<string | null> {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return session.status ?? null;
  } catch {
    return null;
  }
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
