# Plan — ship #142 (account deletion + billing coordination) and close what it leaves open

As of: `b3a0a12` plus the v3.2 coordination-pool follow-up (working tree; not yet committed). This
plan is written **before** the fixes it describes; §7 onwards records execution, so a reader can see
the intent and the result side by side rather than a reconstruction.

> **Why a plan file and not just a PR body.** The PR body records what was *done* and grew by
> appending a section per review round. That reads as progress and hides drift: the body still
> claimed "three files" and "risk: low" while the diff was twelve files, and its last formal verdict
> was three commits behind. A plan file is the opposite artefact — it states what is *not* done yet
> and who must act, and it is falsifiable against a SHA.

**PR:** [#142](https://github.com/jtanori/solara/pull/142) · **Branch:** `arena/7bfcb981-solara`
· **Base:** `staging` (from `c87c3dd`) · **Issues:** closes #141, #144 · **Related:** #143 (separate, not fixed here)
**Labels:** `type:bug` `area:backend` `area:db` `priority:p1` `status:in-review` `deploy:required`

---

## 1. What this PR changes before this plan's round

| # | Change | Commit |
|---|---|---|
| 1 | Deletion write order inverted: audit row first, then delete, so the FK never dangles (#141). | `95afd30` |
| 2 | Route-level test driving the real `defaultDeleteUser`, because the helper-only test passed against the reverted bug. | `8687e82` |
| 3 | Stripe lists walked to the end, failing closed past `MAX_BILLING_PAGES`. | `8d5d533` |
| 4 | Checkout/deletion coordination via per-user advisory lock (#144). | `bf4a418` |
| 5 | Webhook side: audit-only cancellation, integration-test DB hardening. | `031e9c1` |
| 6 | Three review P1s: `wasAccountDeleted` proof, transient cancel propagates, deletion re-reads under the lock. | `8634bf3` |
| 7 | This plan file. | `2821d1f` |

## 2. The findings this round must close

### 2.1 `tests/billing-state.test.ts:50` — SEC-07, the route is still not covered

The review asked for a route-level regression because faking the page walk proves the helper walks
pages, not that `deleteAccount` uses it. The claim that extracting `assessDeletionBilling` answered
this is **wrong**, and the reviewer's own mutation proves it at head: replace the route's
`assessDeletionBilling(...)` call with a first-page-only read and `tests/billing-state.test.ts` stays
at **16 pass / 0 fail**.

Cause: `deleteAccount()` calls `currentUser()`, `getLocale()` and `passwordHashFor()` directly, so no
test can reach the branch that decides clear vs. ongoing.

**Fix:** add the missing seams to `ProfileDeps` (`currentUser`, `locale`, `passwordHashFor`) and one
DB-gated route-level test file driving the shipped handler. Collateral: the existing
`tests/checkout-deletion-race.test.ts` injects whole user snapshots through `currentUser`, so the
seam must be a function returning the same shape `currentUser()` does, not a narrower one.

### 2.2 Two unresolved review threads block merge

`required_review_thread_resolution: true` on `staging`. Thread 1 (`profile/route.ts`) is
`isOutdated` with `path: null` — addressed in code, but detached, so only the reviewer or operator
can resolve it. Thread 2 is the SEC-07 finding above and must be resolved **after** §2.1 lands.

### 2.3 PR body is false at head

L16 "One story", L89 "Risk level: **low**. **Three files**", L109–111, L121 all describe the original
ordering fix. Actual: 13 files, +1688/−60, 7 commits. Rewrite, do not append.

### 2.4 #144 acceptance criteria — 2 of 4 unmet

- Box 1 (failure modes documented): the lock is held across Stripe network calls with no timeout and
  deletion's billing gate runs outside the lock. Neither documented.
- Box 4 (`webhook:unmapped` owner + runbook): unmet, nothing under `docs/operations/`.

### 2.5 No verdict at head

Last verdict names `8d5d533`. This document cannot fix that; it records it so the operator does not
merge on a stale verdict.

---

## 3. Execution plan for this round

Ordered so each step's evidence exists before the next depends on it.

| Step | Work | Why it cannot be skipped |
|---|---|---|
| **E1** | `ProfileDeps` gains `currentUser`, `locale`, `passwordHashFor` | Without it no test can reach the billing branch; §2.1 is unfixable |
| **E2** | New `tests/profile-deletion-gate.test.ts` (DB-gated): live sub on page 2 blocks with 409/`subscription_ongoing`; Stripe list failure blocks with 503/`billing_unverifiable`; clear path deletes and returns 200 | Drives `deleteAccount`, the shipped handler |
| **E3** | Mutation: revert the call to first-page-only → E2 must fail | Proves E2 reaches the code, not a copy of it |
| **E4** | Lock timeout: `SET LOCAL lock_timeout` + `statement_timeout` in both `pg_advisory_xact_lock` sites | A hung Stripe call inside the checkout lock otherwise pins a pooled connection **and** blocks deletion for that user indefinitely — an availability bug this PR introduced |
| **E5** | New test: a held lock makes a deletion attempt fail closed and fast, rather than hang | E4 is unproven without it; also needs a dedicated pool so the stuck session cannot starve the harness |
| **E6** | Deletion billing gate inside the locking transaction (re-read customer under lock, assess, then delete) | Today checkout can link a customer between the gate and the delete; the deletion then skips Stripe entirely and relies on a compensating cleanup that may fail |
| **E7** | `docs/operations/webhook-unmapped.md` — owner, steps, what never to do | #144 box 4 |
| **E8** | Document lock-across-I/O failure modes in code + this file | #144 box 1 |
| **E9** | Rewrite PR body top sections; tick #144 boxes; close #144 manually after merge | §2.3, §2.4 |
| **E10** | Full verification: typegen, tsc, eslint, build, whole suite twice, leak check, mutation matrix | "No more findings" is only credible if measured |

### 3.1 Collateral changes this plan expects (and must handle)

| Collateral | Handling |
|---|---|
| `deleteAccount`'s signature grows six optional deps | All default to production behaviour; `DELETE` keeps Next's exact `(request) => Response` shape or route typegen fails |
| `tests/checkout-deletion-race.test.ts` passes whole snapshots as `currentUser` | Seam type must match `typeof currentUser`; verified by tsc, not by hope |
| Deletion now opens a transaction around billing | `billingIsConfigured()` / `getStripe()` must be resolved **before** the transaction, or a 503 gets raised inside a held lock |
| `tests/billing-state.test.ts` stays green through all of it | It tests helpers; it must not start failing for unrelated reasons |
| Leaked rows: several tests share one process | Every new test cleans by user id **and** customer id, in `finally` |
| CI: `db:migrate` needs `DATABASE_URL_DIRECT` in `ci.yml` | Verified by reading the workflow — it is set |
| Local `initdb`/Postgres is not on `PATH` | Use `pgserver` binaries on loopback; the suite's own loopback guard rejects anything else |
| A test that holds an advisory lock needs its own connection | Otherwise it consumes one of the 5 pool slots in the same process for the whole file |

### 3.2 Items to justify or explicitly skip

| Item | Decision |
|---|---|
| Background reconciliation for orphaned Stripe customers | **Skip** — needs ops infrastructure and a human owner; the webhook quarantine covers detection. Recorded in §6. |
| Retry/backoff for `cancelBillingForDeletedAccount` | **Skip** — the account is already gone; Stripe retries the webhook, and the audit row makes it findable. A retry queue is its own issue. |
| Paginated reads in `checkout/route.ts` (live `subscriptions.list`, `sessions.list`) | **Not this PR** — it is #143, same bug class, different path. Listed in §6 so it cannot age. |
| A second reviewer / approval gate | **Never** — catch-22 rule, PR_WORKFLOW §0. |

---

## 4. Sequence to merge

1. E1–E6 land with E2/E5 tests and the mutation matrix.
2. E7–E9: runbook, documentation, body rewrite, issue bookkeeping.
3. E10: full verification; record exact numbers.
4. Request a fresh verdict at the new head — this document is the input to that request, not a
   substitute for it.
5. Reviewer re-anchors thread 1; thread 2 resolved once E2 exists.
6. Squash merge to `staging`; confirm issue auto-closes rather than assuming either way.
7. Post-merge: close #144 manually, staging QA per §5.

## 5. Deploy and rollback

`deploy:required` — runtime behaviour changes in two route handlers and the Stripe webhook.

- **Migration-bearing:** `0005_account_lifecycle_leases` adds the lease table and index. Preflight the
  preview DB against the exact PR head before `scripts/deploy.sh` checks preview readiness:
  `npx tsx scripts/db-remote.ts --pr <n> --env staging`.
- Staging QA: delete an account with no billing (200, gone, audit row with `actor_id` null and
  `target` = deleted id, plus the association row); attempt deletion with a live subscription
  (blocked 409, not 500); deliver a new unmapped subscription event (quarantine, **no** cancellation; replaying the same
  event id is a duplicate); deliver one with a provable `deleted_customers` association
  (cancellation); confirm `/api/ready`.
- While `0005` is applied but old code is still serving, the old deployment's `/api/ready` returns
  `503`. That is expected readiness skew, not a rollback signal.
- **Rollback:** after `0005`, old code does not know the migration and cannot pass `/api/ready`.
  Recovery is forward-fix; a tested restore is the last resort. Do not promote a pre-`0005`
  deployment. `LIFECYCLE_ADVISORY_COMPAT` is off by default; normal rollout drains old instances.
  If overlap cannot be avoided, enable it only for the cutover window, size
  `DB_COORDINATION_POOL_MAX` for the expected concurrency, and set it back to `0`.

## 6. Known limits after this PR

- Orphaned Stripe customers are **detected** (`webhook:unmapped`) and, when deletion is provable,
  cancelled — but there is no sweeper reconciling Stripe against the database.
- A deletion whose post-commit cancellation fails still needs a webhook to finish the job. Logged
  with `profile.deletion_billing_cleanup_failed`; findable, not automatic.
- **#143** (checkout duplicate-subscription guard reads only the first Stripe page) is live and
  unfixed. Same class as #3 above, on a path this PR does not touch.
- The `tests/billing-state.test.ts` helpers remain the unit-level proof; E2 is the route-level proof.
  Both are needed — the first would pass a mutation the second catches.
- Coordination uses `account_lifecycle_leases` (TTL 60s, heartbeat 15s, acquire wait 5s) on the app
  pool; those queries are short and autocommit. Compatibility is off by default. If explicitly
  enabled for a controlled overlap, it additionally holds one coordination connection for up to the
  Stripe transport timeout; with `DB_COORDINATION_POOL_MAX=3`, a burst of compatibility holders
  returns 503 rather than consuming the app pool. Lease queries use the app pool and are not starved
  by those holders.
- An ambiguous `sessions.create` timeout can leave a server-side session after the lock is released.
  Deletion expires it if still open; the webhook cancels a paid subscription but does not refund the
  initial charge.
- The webhook does not take the account lifecycle lock. A subscription row can be written after the
  final database re-check; provider checks, post-commit cleanup, and the webhook are compensating,
  not a full serialization.
- Same-event webhook replay is a duplicate; only a new event id re-evaluates ownership.
- Expiring sessions happens before the final `FOR UPDATE` gate, so a blocked final gate can leave
  sessions expired without deleting the account.
- A crash between `customers.create` and the DB link can leave an orphan customer; the idempotency key
  makes retry safe, but there is no sweeper.

---

## 7. Execution record

**Baseline before this round:** `2821d1f`, real PostgreSQL 16.2, full suite **380 pass / 0 fail /
0 skipped**. Every number below is measured on that database, not inferred.

### 7.1 What changed

| Step | Change | File |
|---|---|---|
| E1 | `ProfileDeps` gains `currentUser`, `locale`, `passwordHashFor` | `src/app/api/profile/route.ts` |
| E6 | The billing gate moved **inside** the locking transaction; `defaultDeleteUser` returns a `deleted > blocked` union instead of a nullable id | same |
| E4 | `lock_timeout` 5s + `statement_timeout` 20s in all three advisory-lock sites | `src/app/api/profile/route.ts`, `src/app/api/billing/checkout/route.ts` |
| E2 | `tests/profile-deletion-gate.test.ts` — 4 route-level tests driving the shipped handler | new |
| E5 | Lock-contention test proving fail-closed, in `tests/checkout-deletion-race.test.ts` | same |
| — | Existing call sites updated for the union: 1 in `profile-deletion.test.ts`, 3 in `checkout-deletion-race.test.ts` | same |
| E7 | `docs/operations/webhook-unmapped.md` | new |

### 7.2 Why E6 was not optional

The gate used to be assessed from the request's snapshot *before* the delete transaction took the
lock. Checkout takes that same lock to link a customer, so a link landing between the two steps was
invisible to the gate: the deletion proceeded and the only thing that would cancel the subscription
was a post-commit compensating call that can fail. Moving the gate under the lock makes "is money
moving?" and "delete" one serialised step. The Stripe round trip now happens while the lock is held —
which is why E4 exists.

### 7.3 Mutations (each restarted from a clean file; each verified with `grep` before running)

| # | Mutation | Result |
|---|---|---|
| M1 | Route's `assessDeletionBilling` call replaced by a first-page-only read — **the reviewer's own mutation** | `profile-deletion-gate`: **pass 2 / fail 2** (was 16/0 at head) |
| M2 | Gate reduced to the database row only (provider check ignored) | **pass 2 / fail 2** |
| M3 | `unverifiable` treated as `clear` (fail open) | **pass 3 / fail 1** — the 503 test fails |
| M4 | `lock_timeout` raised 5s → 30s | lock test fails at **20017ms**: `statement_timeout` is the backstop, and the bound is real |
| — | A first attempt at M3 added unreachable code after an existing `return` and therefore **proved nothing** (4 pass). Discarded and redone correctly. Recorded because a mutation that cannot fail is the same defect the PR is fixing. | |

### 7.4 Collateral, as predicted in §3.1

Every item in that table occurred and was handled, except the CI `DATABASE_URL_DIRECT` item, which
was checked by reading `.github/workflows/ci.yml` rather than changed.

### 7.5 Skipped, and why

| Item | Reason |
|---|---|
| Sweeper reconciling Stripe against the database | Needs scheduled infrastructure and an owner; the webhook quarantine plus the runbook is the detection story. §6. |
| Retry queue for `cancelBillingForDeletedAccount` | The account is already gone; Stripe's own webhook retry is the durable retry, and the failure is logged with the customer id. |
| Paginated reads in `checkout/route.ts` | That is **#143**, a different path. Included in §6 so it cannot go quiet. |
| Approval counts / second reviewer | Catch-22 rule. Never. |

### 7.6 Coordination-pool follow-up (v3.2, historical)

This section records the v3.2 design and is superseded by §7.7; it is not the current mechanism. It
superseded the earlier `lock_timeout`-based acquisition described in §3 E4 and §7.3 M4.

**Design.** Checkout and deletion now share a dedicated coordination pool (`DB_COORDINATION_POOL_MAX`,
default 3, max 10, `application_name=solara-coordination`) and a bounded
`pg_try_advisory_lock(1, hashtext('account-deletion:<userId>'))` session lock. The lock is acquired
outside a transaction, released in `finally`, and the client is destroyed if rollback or unlock fails.
Checkout uses autocommit `drizzle(client)`; deletion runs the provider assessment and expiry while
holding the lock, then one short `drizzle(client).transaction` with `lock_timeout=5s` and
`statement_timeout=20s` for the `FOR UPDATE` re-read, final subscription check, audit rows,
association row, and delete. No transaction spans Stripe I/O.

**Failure handling.** A transient checkout-session expiry is a 503 and deletes nothing. A vanished or
already-expired session is treated as gone. The final transaction re-reads role, verification and
customer id; a customer change fails closed. `kind:"gone"` maps to 401.

**Tests added.**

| File | Coverage |
|---|---|
| `tests/account-lifecycle-lock.test.ts` | same-user exclusion, different-user concurrency, bounded timeout, rollback safety net, unlock/client-destruction failure, no `idle in transaction` |
| `tests/checkout-deletion-race.test.ts` | real stalled Stripe call: coordination connection held, app pool free, lock released; route uses injected lock; lock-timeout 503 |
| `tests/profile-deletion-gate.test.ts` | customer linked under lock, owner/customer changes, final DB subscription re-check, expiry failure, `gone` 401, pool unavailable 503, final `FOR UPDATE` serialization |
| `tests/db-pool.test.ts` | app/coordination names, defaults, caps, TLS, `allowExitOnIdle` |

**Mutation evidence (each from a clean file, restored after the run).**

| Mutation | Test result |
|---|---|
| Remove `pg_advisory_unlock` | lock test **pass 0 / fail 1** |
| Ignore the injected `lifecycleLock` | app-pool isolation **pass 0 / fail 1** |
| Remove the final database subscription re-check | final re-check **pass 0 / fail 1** |
| Catch-and-continue an expiry failure | expiry failure **pass 0 / fail 1** |
| Remove the customer-id change check | customer change **pass 0 / fail 1** |
| Remove `FOR UPDATE` | concurrent role change **pass 0 / fail 1** |
| Remove the `ROLLBACK` safety net | idle-in-transaction assertion **pass 0 / fail 1** |

Two probes initially survived because the test was too weak: the lock probe shared the helper's pool
(so the same session saw its own lock), and the rollback probe asserted only lock freedom, not
transaction state. Both tests were strengthened and the mutations then failed as required.

**Verification (v3.2).** Node `22.23.4`, PostgreSQL 16.15, disposable database:

- Full suite **425 pass / 0 fail / 0 skipped**, run twice (247s and 258s).
- `npx next typegen`, `tsc --noEmit`, `eslint src tests scripts --max-warnings=0`, `npm run build`, `npm run db:manifest:check`, `npm run db:check` (12/12 tables, 14/14 columns, 3/3 indexes) all clean.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- Touched-file residue delta after `account-lifecycle-lock`, `checkout-deletion-race`, `profile-deletion-gate`, `profile-deletion`, and `db-pool`: **0 users / 0 audit rows / 0 associations / 0 subscriptions / 0 stripe events**. The disposable database still contains 2 users, 23 audit rows and 3 associations from earlier exploratory/failed runs before the final test fixes; those are not produced by the final touched suite.

### 7.7 Lease follow-up (v3.3)

The v3.2 session-level advisory lock is not preserved by PgBouncer transaction pooling, so the
coordination mechanism is now a database lease.

**Schema.** `0005_account_lifecycle_leases` adds `account_lifecycle_leases` (`user_id` PK, `owner`,
`expires_at`, `created_at`, `updated_at`) and `account_lifecycle_leases_expires_idx`. No FK to
`users`: the lease can outlive the user and deletion runs under it.

**Protocol.** Acquire with `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now()`; TTL 60s,
heartbeat 15s, acquire wait 5s. Lease acquire/heartbeat/release use the app pool: they are short,
autocommit statements and are not held across provider I/O. Compatibility mode holds the old
one-argument advisory lock on the separate coordination pool, so it cannot starve lease queries. The
owner is fenced with `select 1 ... for update` inside the final checkout/deletion transaction, and
both paths lock the lease row before the user row. Release deletes only the owned row.

**Expiry.** The provider assessment remains read-only and deadline-bounded. Expiry is capped at 100
open sessions and 20s; after the deadline the route aborts remaining calls and waits for the in-flight
expiry before releasing the lease. The lease is re-checked before and after every session expiry, so
a lost/taken-over lease stops the next Stripe write even though the final database fence comes later.
A failed/lost lease fails closed with 503 and deletes nothing. The final delete transaction uses
`statement_timeout=14s`, below the app pool's 15s. Expired-lease cleanup compares against database
`now()`, never the application clock. A checkout-session expiry is settled only on Stripe's
`resource_missing` code or an explicit already-expired 400; a bare 404 is unverifiable and blocks
deletion.

**Compatibility.** `LIFECYCLE_ADVISORY_COMPAT` is off by default. While explicitly enabled for a
controlled overlap, the lease holder also takes the old one-argument
`pg_advisory_xact_lock(hashtext('account-deletion:<userId>'))` so pre-lease instances are excluded.
The coordination transaction spans provider I/O and consumes one connection per concurrent
operation; size `DB_COORDINATION_POOL_MAX` for that window and set the flag back to `0`.

**Deploy.** Preflight the preview DB with `db-remote --pr <n> --env staging` before `deploy.sh`; the
new preview needs `0005` before preview readiness can pass. After `0005`, old code's `/api/ready`
returns 503 and automatic rollback cannot verify readiness: forward-fix or restore, do not promote a
pre-`0005` deployment.

**Mutation evidence (v3.3).**

| Mutation | Test result |
|---|---|
| Acquire ignores `expires_at <= now()` | same-user serialisation **fail 1** |
| `assertHeld` drops the owner predicate | old-owner fencing **fail 1** |
| Deletion drops the final `lease.assertHeld` | lease-expiry deletion **fail 1 (200, expected 503)** |
| Expiry cap disabled | cap test **fail 1 (200, expected 503)** |
| `checkout_session_not_open` treated as gone | complete/open classifier **fail 1 (200, expected 503)** |
| Checkout omits session cleanup after lease loss | lease-loss checkout **fail 1 (no expire call)** |
| Deadline aborts without awaiting in-flight expiry | deadline test **fail 1 (settled false)** |
| Compatibility uses the lease pool instead of a separate pool | pool-starvation test **fail 1 (CoordinationPoolUnavailable)** |
| Expiry loop skips its per-session lease check | mid-expiry takeover test **fail 1 (second session expired)** |
| Bare 404 treated as a missing checkout session | bare-404 test **fail 1 (200, expected 503)** |
| `RELEASE_SQL` drops the owner predicate | release-takeover test **fail 1 (new owner row deleted)** |
| Lease cleanup uses `new Date()` instead of DB `now()` | cleanup clock-skew test **fail 1 (future row deleted)** |
| `LIFECYCLE_ADVISORY_COMPAT` defaults on | compatibility-is-opt-in test **fail 1** |
| Compatibility pool default changes from coordination to app | default-compatibility test **fail 1** |
| Lease pool default changes from app to coordination | default-pools test **fail 1** |

The six-holder default test also fails if compatibility is enabled by default: with a three-connection
compatibility pool, the fourth holder stalls and the default concurrency assertion times out.

**Verification (v3.3).** Full suite **446 pass / 0 fail / 0 skipped**; `db:check` is **13/13 tables,
19/19 columns, 4/4 indexes**; typecheck, lint, build and manifest check clean.
