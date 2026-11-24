# Payments, profile, users and admin — findings and amended plan

Companion to `product-systems-current-implementation.md` (verbatim source).
Read, not executed: there is no test file for any of these four surfaces, and no database
in this sandbox. Claims about Stripe behaviour are from the code, not from a live call.

---

## 1. What is actually well built here

Stating this first, because three separate things in this subsystem are better than most
implementations and should not be touched:

**The webhook is order-independent by construction.** `stripe-sync.ts` claims the event id
with `onConflictDoNothing`, takes `pg_advisory_xact_lock` on the subscription id, then
**re-reads the subscription from Stripe** instead of trusting the payload. Events that
arrive out of order therefore converge on current truth. This is the correct answer to the
problem most integrations get wrong.

**Entitlement is derived, never asserted.** `grantsAccess` requires
`metadata.solara_product === "premium"` **and** `isPremiumPrice(priceId)`, and
`hasPremiumAccess` additionally requires `status ∈ {active, trialing}` **and**
`currentPeriodEnd > now()`. `users.plan` is dead (`grep` for `users.plan` outside the
schema: zero reads), so nothing can be gated on a stale column. Checkout refuses a second
subscription both from the local table and from Stripe, closing the "webhook hasn't
arrived yet" race.

**Checkout is idempotent and reuses open sessions.** Customer creation carries an
idempotency key; a second click returns the existing open session URL instead of
creating a duplicate; the price is re-fetched and validated before the session is created.

**Role escalation is correctly bounded.** An admin can never touch an owner or another
admin, cannot change their own role, and the check is on both `target.role` and
`data.role` — so an admin can neither demote an owner nor promote anyone (including
themselves indirectly) into admin. The select in the UI is disabled, and the server
does not rely on that.

---

## 2. Findings

### P1 — Billing events can be dropped and the customer keeps access (or loses it) silently

`processStripeEvent` can return without doing anything in three ways, none of which is
recorded anywhere:

1. `if (!claimed || !id) return;` — the event id was already claimed (fine), **or** the
   event type carries no subscription id (silently ignored).
2. `if (!owner) return;` — neither `metadata.solara_user_id` nor `stripeCustomerId`
   matched a user. The event is marked processed and **never applied**. A subscription
   paid for by a user whose `users.stripeCustomerId` was cleared, or whose metadata was
   lost, is simply not linked.
3. `if (owner.customerId && owner.customerId !== customerId) throw …` — this one throws,
   which produces a 500, which makes Stripe **retry forever** on an event that can never
   succeed.

The event id is claimed in the *same transaction* as the work, so a throw rolls the claim
back and the retry re-attempts — correct for transient failures, wrong for permanent
mismatches. There is no dead-letter path and no alert: the only trace is a `log.error`.

**Impact:** a user can pay and not get access, or keep access after cancelling, with no
signal beyond a log line nobody reads. `hasPremiumAccess` reads the DB, so a missed
`customer.subscription.deleted` leaves `grantsAccess` true until `currentPeriodEnd`
passes — which is the fallback that saves this from being S1-grade.

**Fix:** return a discriminated outcome (`applied | duplicate | unmapped | mismatch`),
log unmapped/mismatch at warn, and record them in a small `webhook_failures` table (or an
`audit_logs` row) so they are queryable. Keep throwing only for genuinely transient
errors. Add the event id to every log line.

### P2 — No reconciliation job, so the DB is the only truth

There is no "sync this customer from Stripe" path except the webhook. If a webhook is
lost upstream (Stripe retries for 3 days, then drops it), nothing ever repairs the row.
The dashboard's `BillingSync` polls the *page* for up to 30 seconds after checkout — that
is a UX affordance, not a reconciliation.

**Fix:** a `scripts/` reconciliation command that pages through Stripe subscriptions and
compares to `subscriptions`, reporting drift. Not automatic: read-only first, and it gives
you the evidence to decide whether a scheduled version is warranted.

### P3 — Account deletion is not audited, and re-authentication is not required

Covered in the auth amendment (§S1, §S5) but it belongs here too, because deletion is the
one place payments and profile meet: the route refuses to delete while a subscription is
live (correct), then deletes the user, cascading `subscriptions`, `readings`,
`reading_documents`, `sessions`. Nothing is written to `audit_logs`, so a support
question about a departed customer has no answer, and Stripe still holds a customer
object pointing at a user id that no longer exists.

**Fix:** audit row + password confirmation, and decide explicitly whether to delete the
Stripe customer (I would not — keep it for accounting, tag it with the deleted user id).

### P4 — `knowledge` overrides can be written but never deleted

`PUT /api/admin/knowledge` upserts an override. There is **no delete path**: once an editor
saves a note, the built-in default in `lib/content.ts` can never be restored from the UI,
and nothing records what the previous value was. `auditLogs` gets
`knowledge:update` + the key, but not the old body.

Also: the admin panel's textarea is seeded from the *effective* value
(`notes[key] ?? defaultNote(...)`), so an editor who opens a note and saves without
changing anything silently converts a default into a stored override — permanent, and
invisible.

**Fix:** store the previous body in the audit row, add a "reset to default" that deletes
the override, and make the textarea visually distinguish default from override.

### P5 — The audit trail is write-only

`auditLogs` has three writers (`role:…`, `knowledge:update`, `password:reset`) and **zero
readers** — no query anywhere in `src/`. Combined with P3 (deletion unlogged) this means
the system records exactly the events nobody can look at, and omits the one that matters
most.

**Fix:** an admin-visible audit view (read-only, paginated, filter by actor/action), and
add the missing writers. Until it is readable, the table is a liability rather than a
control.

### P6 — Role changes take effect instantly, with no re-authentication and no notification

`PATCH /api/admin/users` updates `users.role` and returns. The target's session is
untouched. Because `currentUser()` re-reads the role on every request, the change is
effective immediately — which is right — but the user is never told, and a demoted admin
discovers it by being redirected. There is also no email on role change even though the
mail transport is right there.

**Fix (cheap):** send a short "your access level changed" email, and add `sessions.createdAt`
so the change can be correlated with the sessions that predate it.

### P7 — Ownership has no in-product recovery

- `admin/users`: you cannot change your own role (deliberate, good).
- `api/profile`: an owner cannot delete their account ("transfer ownership first").
- **There is no transfer, and no way to designate a new owner except another owner
  changing the role.**

So a single owner who loses access to their account locks the installation out of owner
capability permanently. The local seed script creates the owner
(`owner@solara.local`), which is fine for development and is not a production path.

**Fix:** either an owner-only "transfer ownership" action (make target owner, self admin,
one transaction, audited), or a documented, guarded CLI (`scripts/transfer-owner.ts`) that
requires the same allowlist guards as `seed-users.ts`. Decide which; do not leave it
implicit.

### P8 — Profile has no password change

`PATCH /api/profile` accepts `name` only. A signed-in user can change neither their
password nor their email — the only rotation path is "forgot password", which requires
using the emailed token and signs you out of everything. That is a working recovery flow
standing in for a basic feature.

**Fix:** `PATCH /api/profile` with `currentPassword` + `newPassword`, reusing
`verifyPassword` + `hashPassword`, revoking other sessions. Small, and it removes the
awkwardness of P3's re-authentication requirement (the same primitive).

### P9 — Users list is unpaginated and loads every account into the RSC payload

`app/admin/page.tsx` selects **all** users (`orderBy createdBy`) with no limit and hands
them to a client component. At 10k accounts that is a multi-megabyte page and the panel
maps every row. There is no search, no filter, no sort control.

**Fix:** paginate server-side, search by email, and render a bounded page. This becomes
urgent the moment the product has real users.

### P10 — Pricing has no proration, trial, coupon or upgrade-path modelling

`checkout` always creates a fresh `mode: "subscription"` session for the configured price.
The 409 guard means an existing subscriber can never change plan through the product —
they must use the Stripe portal, which is fine but is not stated anywhere in the UI
(the pricing page still shows "Choose Premium" until `paid && customer`).

Also note the UI honours `allow_promotion_codes: true` with no corresponding product
surface, and `success_url` is fixed to `/dashboard?billing=success` regardless of which
chart the user came from.

**Fix:** decide the plan-change story (portal-only is a legitimate answer — then the pricing
page should say so and link to the portal for existing subscribers) and make the success
URL carry the originating reading.

### P11 — Verification is manual and undocumented in the product repo

There is a genuinely good end-to-end gating verifier (`scripts/verify-gating-production.ts`)
that exercises the built server: unauthenticated 404s, role scoping, ignored `?role=`,
payload leakage. It has guard rails against non-loopback databases. But it is a manual
script, referenced only in a comment, and nothing runs it.

**Also verified:** there is no test for `admin/users`, `admin/knowledge`, `api/profile`,
`stripe-sync` or `stripe-events`. The most security-sensitive routes in the product have
the least coverage.

**Fix:** unit tests for the two admin routes against a fake db (the `auth-endpoint.test.ts`
pattern), and a `stripe-sync` test with a stubbed Stripe client covering the four
outcomes from P1. That is a day's work and it is the highest-value test in the repo.

---

## 3. Amended sequence

### Step 1 — Make billing failures visible (P1, P2)

- `processStripeEvent` returns a status; the route logs it with the event id.
- Unmapped and mismatched events get a durable record and a warn (not an infinite retry).
- A read-only `scripts/reconcile-stripe.ts` that diffs Stripe against `subscriptions`.

Tests: stubbed Stripe client → applied / duplicate / unmapped / mismatch.

### Step 2 — Coverage for the two admin routes (P11)

Unit tests for role escalation and knowledge validation, against a fake db. These routes
guard the most damage per mistake and currently have none.

### Step 3 — Audit trail becomes a control (P3, P5)

- Writers: `account:delete`, `subscription:reconcile`, `knowledge:delete`.
- Readers: an admin-only, paginated audit view.
- `knowledge` overrides gain a delete ("reset to default") and the old body is stored.

### Step 4 — Profile completes (P8, P3)

Password change with re-authentication, reused for account deletion confirmation.

### Step 5 — Owner continuity (P7)

Transfer-ownership action **or** a guarded CLI, plus an email on role change (P6).

### Step 6 — Scale the users list (P9)

Server-side pagination + email search before real customer counts arrive.

### Step 7 — Decide the plan-change story (P10)

Portal-only is defensible; write it down and make the pricing page say it.

---

## 4. One-paragraph version

Payments, profile, users and admin are one pipeline and the pipeline is sound: derived
entitlement, order-independent webhook, bounded role escalation, idempotent checkout. What
is missing is *observability and completeness* — billing events can be dropped with no
record, the audit table has three writers and no readers, account deletion (the most
destructive action) is unlogged and unconfirmed, editors can create overrides but never
remove them, the users list loads every account, and there is no owner transfer and no
password change. Nothing here needs rebuilding; six of the seven steps are small, and the
seventh is a decision.

---

## 5. What I could not run

`billing-integration.test.ts` is behind `RUN_BILLING_INTEGRATION_TESTS=1` and needs a
local disposable database; `billing.test.ts` passed as part of the suite. No admin, profile
or stripe-sync test exists to run. Everything above about the webhook, the routes and the
admin panel comes from reading the code — including the four early-return paths in
`stripe-sync.ts`, which I traced by hand rather than by executing.
