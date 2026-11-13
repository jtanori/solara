# Plan — ship #142 (account deletion + billing coordination) and close what it leaves open

As of: `2821d1f`. This plan is written **before** the fixes it describes; §2.7 onwards records
execution, so a reader can see the intent and the result side by side rather than a reconstruction.

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

- No `drizzle/` change, so no migration dispatch. Confirm on the diff, not on the label.
- Staging QA: delete an account with no billing (200, gone, audit row with `actor_id` null and
  `target` = deleted id); attempt deletion with a live subscription (blocked 409, not 500); replay an
  unmapped subscription webhook (quarantine, **no** cancellation); replay one with a provable
  `account:delete` row (cancellation).
- Rollback: revert the squash commit and redeploy. Prior behaviour returns (deletion 500, pagination
  blind spot); nothing to unwind in schema or data.

## 6. Known limits after this PR

- Orphaned Stripe customers are **detected** (`webhook:unmapped`) and, when deletion is provable,
  cancelled — but there is no sweeper reconciling Stripe against the database.
- A deletion whose post-commit cancellation fails still needs a webhook to finish the job. Logged
  with `profile.deletion_billing_cleanup_failed`; findable, not automatic.
- **#143** (checkout duplicate-subscription guard reads only the first Stripe page) is live and
  unfixed. Same class as #3 above, on a path this PR does not touch.
- The `tests/billing-state.test.ts` helpers remain the unit-level proof; E2 is the route-level proof.
  Both are needed — the first would pass a mutation the second catches.

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
