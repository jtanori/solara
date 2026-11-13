# Plan — ship #142 (account deletion + billing coordination) and close what it leaves open

As of: `8634bf3` (code). This plan file itself is one additional docs commit on the same branch.

> **Why a plan file and not just a PR body.** The PR body records what was *done* and grew by
> appending a section per review round. That reads as progress and hides drift: the body still
> claims "three files" and "risk: low" while the diff is twelve files, and its last formal verdict
> was three commits behind. A plan file is the opposite artefact — it states what is *not* done yet
> and who must act. It belongs in the tree because the merge checklist outlives this PR.

**PR:** [#142](https://github.com/jtanori/solara/pull/142) · **Branch:** `arena/7bfcb981-solara`
· **Base:** `staging` (from `c87c3dd`) · **Issues:** closes #141, #144 · **Related:** #143 (separate, not fixed here)
**Labels:** `type:bug` `area:backend` `area:db` `priority:p1` `status:in-review` `deploy:required`

---

## 1. What this PR actually changes

One production bug, three follow-ons it made reachable, all on the same surface:

| # | Change | Commit |
|---|---|---|
| 1 | Deletion write order inverted: audit row first, then delete, so the FK never dangles. This is the shipped bug (#141) — deletion returned 500 for every user. | `95afd30` |
| 2 | Route-level test that drives the real `defaultDeleteUser`, because the helper-only test passed against the reverted bug. | `8687e82` |
| 3 | Stripe lists walked to the end, failing closed past `MAX_BILLING_PAGES`; first-page-only read would delete an account with a live subscription on page 2. Latent until #1 landed. | `8d5d533` |
| 4 | Checkout/deletion coordination via per-user advisory lock; customer link must land (`.returning()`); post-create survival re-check (#144). | `bf4a418` |
| 5 | Webhook side: cancel only on proof of deletion, retry transient failures, integration-test DB hardening. | `031e9c1` |
| 6 | Three review P1s: `wasAccountDeleted` port, transient cancel propagates, deletion re-reads the customer id under the lock. | `8634bf3` |

Size at `8634bf3`: **12 files, +1493 / −60, 6 commits** — 4 source files changed, 3 source files added, 5 test files. This plan file makes it 13.

## 2. Merge readiness — open, in priority order

### 2.1 `tests/billing-state.test.ts:50` — reviewer's Medium is **not** fixed (verified, not assumed)

The thread asks for a route-level regression, because faking the page walk only proves the helper
walks pages, not that `deleteAccount` uses it. The PR claims this was answered by extracting
`assessDeletionBilling`. **That answer does not close the hole**, and I re-ran the reviewer's
mutation to prove it:

```
# replace the route's assessDeletionBilling() call with a first-page-only read
npx tsx --test tests/billing-state.test.ts
# pass 16 / fail 0          <- the mutation survives
```

The reason is structural: `deleteAccount()` calls `currentUser()`, `getLocale()` and
`passwordHashFor()` directly, so no test can reach the branch that decides *clear vs. ongoing*
without a database and a request context. Extracting the helper moved the code; it did not make the
caller observable.

**Unblocking action (recommended):** add the two missing seams to `ProfileDeps`
(`currentUser?`, `locale?`) — `stripe` and `deleteUser` are already injected, so this is the same
pattern, ~20 lines. Then one test: an ongoing subscription on page 2 must block deletion, and
first-page-only must fail it. This is the third time in this PR that a green test did not reach the
broken code (`95afd30` → `8687e82` → this), so it is worth doing properly rather than re-arguing.

**Alternative:** record explicit operator risk acceptance on the thread. Legitimate, but note that
the same class of gap has already produced two real defects here.

### 2.2 Two unresolved review threads block merge mechanically

`required_review_thread_resolution: true` on `staging`, so merge is blocked until both threads are
resolved — regardless of code quality or CI. Current state:

| Thread | Anchored | Resolved |
|---|---|---|
| `src/app/api/profile/route.ts` — P1 checkout/deletion race | `isOutdated: true`, `line: null` | **no** |
| `tests/billing-state.test.ts:50` — SEC-07, route wiring | `isOutdated: false`, `line: 50` | **no** |

The first is addressed in code (`bf4a418`, `031e9c1`) and has a real two-session interleaving test.
It cannot be resolved by the author: it is outdated and detached, so it needs either the reviewer to
re-anchor it at head or the operator to resolve it. **Do not resolve 2.2-thread-1 before
2.1 is settled** — the reverse order would silently close the thread that still has an open finding.

### 2.3 PR body is materially false at head

The body's first sections were written for `95afd30` and appended to, never invalidated:

| Line | Claim | Actual |
|---|---|---|
| L16 | "One story: one bug, one fix, one test rework" | 6 commits, 4 logical changes, one of them (`bf4a418`) a coordination feature |
| L89 | "Risk level: **low**. **Three files**, one transaction's statement order" | 12 files, +1493/−60, a lock protocol and webhook behaviour change |
| L109–111 | "Plan adherence: diff matches #141", "no silent catches" | matches #141 **and** #144; catch behaviour was itself a P1 in round 5 |
| L121 | self-review checklist | describes the original ordering fix only |

This is the same failure mode as §2.1 and the same one the reviewer fell into (their P1-c was
accurate at `031e9c1` and is stale at `8634bf3`): the artefact that describes the work was not
re-derived from the head. **Fix before merge** — replace the stale lines, do not append again.
The recommendation this produced is now item A3/A4 in §5.

### 2.4 #144 acceptance criteria — 2 of 4 are genuinely unmet

`Closes #144` is in the body, but #144 targets `staging` while the default branch is `main`, so it
will **not** auto-close; it needs a manual close after merge.

- [x] **Box 1 — failure modes documented:** *partly*. The lock is held across Stripe network calls
  with no timeout, and deletion's billing gate runs *outside* the locked transaction. Both are real
  failure modes, and neither is documented in code as the box requires. The lock-across-I/O point is
  also an availability risk: a hung Stripe call stalls checkout *and* deletion for that user while
  holding a pooled connection.
- [x] **Box 2 — test that fails if coordination is removed:** met. Mutation-verified: removing the
  deletion lock fails the `lock:` test; dropping the under-lock re-read fails the `escape path` test.
- [x] **Box 3 — outcome observable:** met. Session expired, or customer cancelled, or quarantined.
- [ ] **Box 4 — `webhook:unmapped` has a defined owner and runbook step:** **unmet**. The code writes
  the audit action and names it clearly, but no runbook tells a human what to do with one. Nothing
  under `docs/operations/` covers it.

### 2.5 Verdict drift — a procedural blocker, not a technical one

Last posted verdict names `8d5d533`. Head is `8634bf3` — three commits later, including the three
P1s that changed cancellation policy. The operator's own standing rule (PR_WORKFLOW §3.3) is that no
PR merges without a verdict naming the reviewed SHA. **A fresh verdict at `8634bf3` is required**,
and it must verify §2.1 as fixed rather than take this document's word for it.

### 2.6 Confirmed non-blocker: CI

Run `43375868349` on `8634bf3` is green: `verify` 3m33s, `pr-lint`, Vercel, GitGuardian, Vercel
Preview Comments. No required check is failing, and required checks are `verify` only.

## 3. Sequence to merge

1. Fix §2.1 (seams + one route-level test, mutation-verified).
2. Correct §2.3 in the body — one rewrite, not another appendix.
3. Request a fresh verdict at the new head (§2.5).
4. Reviewer re-anchors or resolves thread 1; resolve thread 2 once §2.1's test exists.
5. Merge squash to `staging` (linear history is required).
6. Close #144 manually; verify #141 auto-closed (it targets `staging` like this PR — check, do not
   assume either way).
7. Tick the four #144 boxes *after* the code that satisfies them has landed.

## 4. Deploy and rollback

`deploy:required` — runtime behaviour changes in two route handlers and the Stripe webhook.

- No `drizzle/` change: no migration, no `migrate.yml` dispatch. Confirm this on the diff rather
  than the label.
- Staging QA after merge: delete a test account with no billing (expect 200, account gone, audit row
  with `actor_id = null` and `target` = the deleted id); attempt deletion with a live subscription
  (expect blocked, not 500); replay a Stripe test webhook for an unmapped subscription (expect
  `webhook:unmapped` quarantine and **no** cancellation); then one with a provable
  `account:delete` row (expect cancellation).
- Rollback: revert the squash commit and redeploy. The prior behaviour (deletion 500, and the
  pagination blind spot) returns; no schema or data migration must be undone.

## 5. Follow-up work this PR must not absorb

Kept out on purpose — separate PR, `type:docs` + `type:ci`, against `staging`. All advisory or
author-procedural; none may become a gate a solo operator cannot satisfy (PR_WORKFLOW §0).

| ID | Change | Why |
|---|---|---|
| **A4** | `pr-lint` compares *declared* risk/size in the body to the actual `changed_files`/`additions` | Would have caught §2.3 mechanically — this exact bug, with no trust involved |
| **A1** | PR template gains a completion matrix: `criterion → impl location → test/evidence → limitation`, first line `As of: <sha>` | Turns "it's done" into a claim with locations |
| **A3** | `pr-lint` compares body `As of:` to head SHA; red advisory on drift | Catches §2.3 and §2.5 before a reviewer has to |
| **D1** | Required "What these tests do NOT cover" section | §2.1 is precisely a test that proved the wrong layer |
| **D2** | Mutation table gains *invariant protected* + *what it would still miss* | A mutation matrix that does not say what it misses overstates itself |
| **B1–B4** | Machine-readable verdict comment pinned to a SHA; blocking findings must be inline; a verdict older than head is not a verdict; `isOutdated` threads re-anchored before resolve | §2.2 and §2.5 are both this |
| **C2** | Re-scope #144 to six enumerated schedules (checkout→delete, delete→checkout, concurrent under lock, webhook before/after delete, transient cancel→retry) | Acceptance criteria as "pick one remedy" invites an argument about remedies instead of coverage |

Two smaller items: remove or document `dismiss_stale_reviews_on_push: true`, which is inert at
`required_approving_review_count: 0` and reads as protection that does nothing; and add the
`webhook:unmapped` runbook step that §2.4 box 4 requires.

Also unfixed and out of scope: **#143** (checkout duplicate-subscription guard reads only the first
Stripe page) — the same pagination bug class, on a path this PR does not touch. It is live and
should not be allowed to age.

## 6. Decisions needed from the operator

1. **§2.1:** add the `currentUser`/`locale` seams and one route-level test, or record explicit risk
   acceptance on the thread? *(Recommend: seams. Both prior versions of this gap produced real
   defects.)*
2. **§2.4 box 1:** document the lock-across-I/O failure mode as accepted, or add a lock timeout?
   *(Recommend: document now, timeout as its own issue — a timeout changes behaviour and needs its
   own tests.)*
3. **§2.4 box 4:** where does the `webhook:unmapped` runbook live — `docs/operations/`, or a section
   in this file? *(Recommend: `docs/operations/`, since it is an operational step, not a plan.)*
4. **§5 timing:** land the workflow PR before or after #142 merges? *(Recommend: after. #142 is the
   evidence for it; shipping the fix and then the mechanism that would have caught its drift is a
   cleaner narrative than the reverse.)*

## 7. Standing constraints for whoever picks this up

- Do not "fix" the FK by dropping `actorId` from the insert or making `actor_id` nullable — the
  audit event must outlive the account, which is the whole point of the row.
- Do not assert `actorId === userId` on the stored row: `ON DELETE SET NULL` nulls it. Assert on
  `target`.
- Cancellation is only ever justified by a durable `account:delete` proof. "Unmapped" alone is not
  evidence of deletion — an unrelated subscription on the same Stripe account is equally unmapped.
- `assert.rejects(..., /23503/)` does not work with Drizzle; the SQLSTATE is on `error.cause.code`.
- Measure the whole suite for leaked rows, not just the file you changed — a cleanup scoped by user
  id misses audit rows keyed by customer id.
- This document must not contain the retired backlog filename, verbatim or otherwise:
  `tests/backlog-snapshot.test.ts` fails if any tracked markdown still names it.
