# Deployment alignment — Actions as the only deployer

**Status:** Approved for phased execution. Not started. Blocked behind the reading features
(ADR 011 sequence); Phases 1–2 are code-only and may start earlier.
**Branch:** `docs/deployment-alignment` → `staging` → promotion to `main`.
**Decision record:** [ADR 012](decisions.md) (readiness tolerates schema-ahead in production).
**Tracking issue:** see GitHub milestone **M5 — Deployment alignment**.

---

## 1. The problem

The pipeline's logic is sound. The problem is *where it runs*.

`scripts/deploy.sh` is a client-side wrapper around `gh pr merge`. The actual deploy trigger is
Vercel's Git integration reacting to any push to `main` or `staging`. The rulesets require a PR and
the `verify` check, so a merge is audited — but nothing forces the merge to go through
`deploy.sh`. A merge from the GitHub UI, from `gh`, or from an agent skips every gate:

- the migration runs late or never;
- Vercel deploys anyway;
- nothing records what happened.

This cannot be fixed with discipline or documentation. It is fixed structurally:

> **Merging is the deploy trigger, and the pipeline that enforces ordering runs server-side, on
> every merge, regardless of who merged or with which tool.**

Three properties make that true:

1. GitHub Actions is the only thing that deploys `staging` and `main`.
2. Vercel's Git auto-deploy is off for those two branches.
3. Every deployment reports which commit and tree it is serving, so "did it land?" is a `curl`,
   not an inference from an email.

There are no users yet. This is the cheapest moment to make the cut.

## 2. Verified facts this plan rests on

Read from the repository; no hosted system was touched.

| Fact | Evidence |
| --- | --- |
| `build` runs `next build`; `prebuild` runs `npm run pdf:build`. No `postinstall`, no migrate step. | `package.json` |
| The build needs `DATABASE_URL` to **exist**, and executes no SQL. | `src/db/index.ts` throws at module load; no module-scope query |
| Every app page that imports the DB also awaits cookies, so nothing is statically generated. | `src/lib/auth.ts` `currentUser()`; no `generateStaticParams` in `src/app` |
| Readiness requires **exact set equality** of applied vs expected migration hashes. | `src/lib/readiness.ts` `buildReadiness` |
| That equality is asserted by a test, so changing it is a policy change. | `tests/readiness.test.ts` "not ready when the database has an unexpected applied hash" |
| `/api/ready` deliberately withholds schema/migration detail outside development. | `src/app/api/ready/handler.ts` (`PublicReadiness`, detail is dev-only) |
| `db-run.ts` is a guard plus **delegation** to `drizzle-kit migrate`, not an applier. | `scripts/db-run.ts` `cmdMigrate` → `spawnSync("npx", ["drizzle-kit","migrate"])` |
| No checked-in workflow invokes `drizzle-kit` directly; hosted migrations go through `db-run`. A repo grep cannot prove what an operator does by hand. | no `drizzle-kit` reference in `.github/workflows/*` |
| `drizzle.__drizzle_migrations.created_at` is the journal's `when` (folderMillis). | drizzle-orm migrator; `db-run.ts` already types `JournalEntry.when` |
| The runtime manifest carries `tag` + `hash` only — `when` is dropped. | `scripts/generate-migration-manifest.ts` |
| `drizzle/meta` is excluded from the deployed artifact, so the runtime cannot check the journal. | `.vercelignore` |
| Two GitHub Environments exist (`staging`, `production`) with **no** protection rules and no branch policy. | `gh api repos/jtanori/solara/environments` |
| `pg` version in CI is 16. | `.github/workflows/ci.yml` service container |
| No `vercel.json` exists. | repo root |
| Rulesets require a PR, the `verify` check, and block force-push/deletion. | `protect-main`, `protect-staging` |
| The catch-22 rule forbids approval counts and APPROVE events **as merge gates**. | `docs/PR_WORKFLOW.md` §0 |

## 3. Deployment model

**Model 1 — merge, then automatically deploy.** Every push to protected `staging` and `main` starts
the corresponding workflow. `workflow_dispatch` exists only for break-glass recovery. A manual local
script is never the deploy path.

A failed deploy is visible in three places: the workflow run, the GitHub Deployment record, and the
mismatch between the branch head and `/api/version`.

Deploy-before-merge is rejected: it requires a privileged workflow to run code and SQL from an
unmerged PR, and it makes the merge a second, weaker gate behind the real one.

### Target architecture

```
feature PR ──► verify ──► preview (Vercel Git, unchanged until Phase 4)
     │
     ▼ merge to staging (UI, gh, agent — any of them)
deploy-staging.yml:  build ─► migrate staging ─► stage ─► verify candidate ─► alias ─► verify live
     │
     ▼ promotion PR (merge commit only) + promotion gate
deploy-production.yml: build ─► [approval if migrations] ─► migrate ─► stage ─► verify ─► promote ─► verify
                                                                                   └─ failure: conditional alias revert (recorded prior + compatible + no mark)
drift-monitor (8a/8b): branch HEAD ≠ live, or migrations state stuck  ─► alert
```

## 4. Failure semantics

Every failure leaves production in a **known, reported state**: either the previous build, or the
candidate with an explicit "no revert" decision. Nothing is inferred from email.

| Fails at | Database | Live site | Signal |
| --- | --- | --- | --- |
| build | untouched | previous build | red run + incident issue |
| migrate | pending batch rolls back as one transaction (`lock_timeout` aborts before commit) | previous build | red run + issue |
| candidate verify | migrated | previous build; candidate never promoted | red run + issue |
| post-promote verify, **matching keyed record** | migrated | revert to the recorded prior deployment ID (alias only) | red run + issue |
| post-promote verify, **absent / mismatched / no prior** | migrated | **no automatic revert**; alias left as-is, page for forward fix | red run + issue + operator decision |
| approval declined | untouched | previous build | run `waiting` → cancelled |

**"Merged but not live" is a first-class state**, reported by the drift monitor, not inferred from
email.

### What auto-revert does and does not mean

Auto-revert is **conditional and default-deny**. It is an alias move to the **recorded prior
deployment ID** — never a down migration, never a database change — and it happens only when all of
these hold:

1. a prior deployment ID was recorded before the candidate was promoted (the legacy stable
   deployment counts; record it if the first Actions deploy is not the first deployment ever);
2. the release carries a **compatibility record matching this prior ID, candidate SHA and applied
   hash set** — default deny when absent or mismatched; and
3. the release does **not** carry the `no-auto-rollback` mark set by a `migration:breaking-approved`
   override.

The release's compatibility record is **operator-written, keyed to the run, and default-deny**. It
carries `compatible: true`, the actual `prior_deployment_id`, the `candidate_sha`, and the
`migration_hashes` the release applies. The alias move requires all three to match the run's actual
prior deployment, candidate, and applied set; a record for another prior build, another candidate, or
another hash set does not authorize it. Before the Actions cutover the legacy path writes the same
record in the deploy record/marker; after cutover the workflow reads it. A release with no record, or
a record that does not match, is treated as incompatible. The `no-auto-rollback` mark overrides any
record.

When the conditions do not hold — a breaking migration, a missing compatibility record, or no prior
deployment at all — the alias is **not** moved automatically. The previous build may talk to a schema
it does not understand; readiness being green does **not** prove it works. The run opens the incident
and pages the operator for a forward fix, or for a deliberate alias move once compatibility is
established.

The alias path is the one part of the current tooling that has never run against the live API.
#76's acceptance is a real drill, and [Phase 3, cutover](#13-cutover) step 9 is that drill.

## 5. Verification: identity, not readiness

`/api/ready` answers "can this build serve?". It cannot answer "is the build I intended actually
serving?" — the old deployment returns `{"ok":true}` quite happily.

`/api/version` (Phase 1) reports:

```json
{ "ok": true, "commit": "3f2a…", "tree": "9c41…", "release": "…", "env": "production",
  "builtAt": "2026-11-19T…", "migrations": "exact" }
```

Rules:

- `force-dynamic`, `Cache-Control: no-store`.
- No database URL, host, migration tag, count, or table name. `migrations` is a **state string**
  (`exact | ahead | behind | diverged`), consistent with the existing detail budget in
  `src/app/api/ready/handler.ts`.
- `/api/ready` gains the same `migrations` string and `commit`.

The deploy workflow verifies, in order: Vercel reports the deployment ready → the deployment's own
URL reports the expected identity → the stable domain resolves to that identity → `/api/ready` says
it can serve. **The workflow result is the release outcome.** `/api/version` answers "what is
serving now?".

### Candidate and post-promote gates

`verify-deployment.sh <url> <expected-sha> <expected-tree>` requires:

- `commit` and `tree` match;
- `migrations ∈ {exact, ahead}` — `behind` and `diverged` are fatal;
- `/api/ready` returns `ok:true` with `db:"ok"`.

Accepting `ahead` is safe because the authoritative guarantee that *this* SHA's migrations are
applied is `db-run.ts verify` inside the migrate job, server-side against the journal — not the app
endpoint. A persistent `ahead` is the drift monitor's problem, not the gate's.

## 6. Readiness policy change (ADR 012)

`buildReadiness` moves from set equality to four states. The **authoritative** matrix — every
condition, the precedence rules, the provenance boundary and the accepted residual risk — lives in
[ADR 012](decisions.md#adr-012--readiness-tolerates-schema-ahead-in-production). It is not restated
here: two copies drifted once already. The invariants to implement are:

- `ahead` requires `expected ⊂ applied` **and** every extra row's `created_at` strictly greater
  than the newest expected `when`. For example, expected `{old}` with applied `{old, unknown-new}`
  is `ahead`, not `diverged`.
- `behind` requires *nothing extra*. Any missing expected row **and** any extra row together is
  `diverged`.
- An older or equal-timestamp extra is `diverged`; an empty manifest is `diverged`.
- The identity-verified database endpoint is the only trusted source (issue 3); `#167` is the
  fixture contract for every cell, including the forged-newer case that is accepted as residual risk.

No numeric cap on `ahead`. The cap provided no safety — a fourth unknown migration is no more
dangerous than a second — and every extra knob becomes a test matrix. The bound is **time**:
`/api/version` reports `ahead` indefinitely, and the drift monitor alerts after the configured
horizon.

**This removes the last automated signal that a rollback is schema-incompatible.** Today
`unexpected > 0` is fatal, which is how an operator learns that rolling back the application is
unsafe. After this change, a rolled-back build reports green. The compensating controls are:

1. a **blocking** destructive-DDL lint on every PR that adds `drizzle/*.sql` (issue 4a);
2. expand/contract discipline for breaking changes, carried from ADR 008 into Phases 1–2 — not only
   documented in the issue 11 rewrite;
3. persistent `ahead` reporting plus a time-bounded alert (issue 8a).

Issue 4a must merge before or with this change. That is an ordering constraint, not a preference.
A rollback also requires recorded compatibility and no **no-auto-rollback** mark — readiness being
green does **not** mean the previous build still works after a breaking migration (see §4).

`/api/ready` also stops reporting `ok:false` during the migrate→deploy window and after an Instant
Rollback. Both are currently outages by construction.

## 7. Environments, secrets, and identity

### GitHub Environments

| Environment | Holds (names only) | Protection |
| --- | --- | --- |
| `staging` | `DATABASE_URL` (staging, direct), `DATABASE_URL_STAGING_READONLY`, `VERCEL_*`, `VERCEL_AUTOMATION_BYPASS_SECRET` | branch `staging` only |
| `production` | `VERCEL_*`, `VERCEL_AUTOMATION_BYPASS_SECRET` | branch `main` only |
| `production-migrations` | `DATABASE_URL` (production, direct), `DATABASE_URL_STAGING_READONLY` | branch `main` only, **required reviewer: operator, Prevent self-review OFF** |
| `production-diagnostics` | `DATABASE_URL_PRODUCTION_READONLY` | branch `main` only, read-only role, no reviewer |

`staging` and `production` already exist with no protection rules. `production-migrations` and
`production-diagnostics` are new.

Why the split: code-only deploys go out automatically; anything that changes the production schema
pauses for the operator, even when an agent merged it.

**Governance note.** Environment protection is a *deploy* gate, not a *merge* gate: it delays a
workflow job, never a merge. It is compatible with `docs/PR_WORKFLOW.md` §0 **only** under the
conditions recorded there as a future-scoped exception, which this PR adds to §0: required reviewer
is the operator with **Prevent self-review OFF** (the same identity can release the job); a waiting
or denied approval is never a required status check or required deployment for any merge; and
required PR checks stay non-API-dependent. The exception is future policy — until cutover is
recorded in [guide 11](setup/11-actions-deploys.md), the current merge and deploy instructions remain
in force. §0 points at this plan; without that amendment a future agent would read the standing rule
and delete the gate, and without the three conditions the gate would be a catch-22.

### Environment identity guard (issue 3)

One module, used at app boot, in `db-run.ts`, and in `drizzle.config.ts`:

| `APP_DEPLOY_ENV` | DB endpoint must be |
| --- | --- |
| `production` | equals `PROD_DB_ENDPOINT` |
| `staging` | equals `STAGING_DB_ENDPOINT` |
| `preview` | neither production nor staging, **unless** the verified transitional exception below is set |

Note: staging is identified from `VERCEL_GIT_COMMIT_REF` (see
[decision-staging-environment.md](decision-staging-environment.md)), so the staging deployment
resolves to the `staging` row above, not `preview`. The transitional exception therefore does not
apply to staging — it is only about whether a feature preview may read staging. If the mapping ever
regresses, staging falls back to `preview` and this guard rejects the staging database at boot: fail
closed.
| `local` | loopback |

Endpoint = first hostname label with `-pooler` stripped. Pooler hosts are rejected for migration
URLs. Fail closed on unknown or unset.

**Preview database guard — enforce a decision before cutover.** The prerequisite is that the guard
**enforces** one of three states. Enabling `ALLOW_PREVIEW_ON_STAGING=1` is one option, not the
prerequisite by itself.

1. **Isolated preview database (proven)** — strict guard; the preview endpoint is neither staging
   nor production.
2. **Read-only staging exception (verified)** — `ALLOW_PREVIEW_ON_STAGING=1`, only after Phase 0
   proves routing actually resolves to staging and the credential granted is **read-only**; a
   preview may read staging, must never migrate it, and must never reach production.
3. **No database access (quarantined)** — if neither can be proven, remove the hosted database
   credential from previews (or disable DB-backed previews) **before** taking the fallback.

The fallback — dropping the preview-readiness merge signal — **does not remove database access**.
Taking it without state 3 leaves unverified previews using the same unverified URL. That is the trap
this ordering exists to close.

The guard decision (#168) is a **hard prerequisite for Actions cutover (#171)**; #176 may follow,
but the quarantine fallback must be available **before #171**, not after it. It is recorded in the
Phase 0 audit.

## 8. Migration detection and the rehearsal gate

### Detection (issue 7)

Decide "does this release carry migrations?" by diffing `drizzle/` **against the commit currently
live in production** (`/api/version.commit`), not against the previous `main` tip and not against
`main~1`. A `curl` and a `git diff expect` — **no database credential in the build job**.

Fail-closed edge cases:

- `/api/version` unreachable or `commit:"unknown"` (first Actions deploy, or a build predating
  issue 1) → treat as "all migrations pending" and route through the migrate job. An unknown live
  state deserves human eyes; this is designed behaviour, not a malfunction, and the runbook says so.
- A previous deploy failed after migrating but before promoting → the live commit is older than
  `main`, so the diff re-runs the (idempotent) migrate job. Correct.

### Build-time database boundary (issues 6 and 7)

The build must not be able to reach a real database, and the artifact must not contain a real
credential. Both are easy to break accidentally:

- `src/db/index.ts` throws when `DATABASE_URL` is absent, so the build needs the variable to
  *exist*; the identity guard (#168) rejects loopback on a hosted boot. Together these mean the
  build cannot simply omit the variable.
- `vercel pull --environment=production` before the build can materialize real runtime variables —
  including the production database URL — into the build workspace if they are pooled.

Rules, applied identically to `deploy-staging.yml` (#171) and `deploy-production.yml` (#173):

1. **Build-only placeholder.** Supply a non-routable placeholder `DATABASE_URL` (loopback host,
   syntactically valid, deliberately wrong credentials) that satisfies the module-load guard and
   cannot connect, **or** refactor the import so the build never evaluates it. The placeholder is a
   test-covered value, not an improvised string; the runtime guard stays fail-closed and never
   treats it as valid.
2. **Prove the boundary, do not assert it.** The workflow records: no SQL or network connection to
   the database during build; no hosted database credential in the workspace; no `vercel pull` env
   file in the uploaded `.vercel/output` or build artifact.
3. **Inject runtime variables at deploy.** The promoted candidate receives the real database and
   other runtime variables through the Vercel deployment's runtime scope, with the correct
   environment and branch scope — never baked at build.
4. **Record the injection mechanism as a prerequisite.** How production and staging runtime
   variables reach the promoted candidate is a **Phase 0 inventory item and an S1 input**, not an
   assumption S1 is expected to prove.

### Content rehearsal (issue 5)

Before applying to production, every pending hash must already exist in **staging's**
`drizzle.__drizzle_migrations`, read with a read-only staging role. Durable, rerun-proof, and
independent of SHAs — which matters because promotions are merge commits.

**What this proves and does not prove.** It proves the SQL has executed on a staging-shaped
database. It does **not** prove the migration succeeds against production data. A Neon branch cloned
from production would be the better rehearsal for data-dependent migrations; with no users, that is
explicitly deferred until production holds meaningful data. Do not describe the staging gate as a
production-data rehearsal anywhere.

### Promotion gate (issue 12)

Two layers, deliberately separated by where they can safely fail.

**(a) Pre-merge signal — advisory, never a required check.** A workflow step or comment computes:

- `tree(staging live commit from /api/version) == tree(PR head)`; and
- no in-flight `deploy-staging` run.

This depends on the Actions API and the hosted `/api/version` endpoint. A required status check with
that dependency would let an API or endpoint outage block a merge — exactly the catch-22 §0
excludes. It is therefore **advisory**: it warns the operator, and nothing more. A required,
fail-closed, live-API-backed check is not sanctioned by this plan and would need its own §0
amendment naming an outage fallback.

**(b) The guarantee — post-merge, fail-closed, server-side, before any privileged work in
`deploy-production.yml`:**

```bash
BASE=$(git rev-parse HEAD^2 2>/dev/null) || { echo "ERROR: not a merge commit"; exit 1; }
# 1. The second parent was a staging commit (staging may legally have advanced since the PR opened).
git merge-base --is-ancestor "$BASE" origin/staging || { echo "ERROR: HEAD^2 is not on staging"; exit 1; }
# 2. The merge changed nothing: the promoted tree is exactly the reviewed staging tree.
[[ "$(git rev-parse HEAD^{tree})" == "$(git rev-parse "$BASE^{tree}")" ]] || { echo "ERROR: merge altered the tree"; exit 1; }
# 3. That tree is what staging actually serves (rehearsed identity), fetched live; unreachable = fail closed.
[[ "$BASE" == "$(curl -fsS "$STAGING_VERSION_URL" | jq -r .commit)" ]] || { echo "ERROR: promoted tree is not live on staging"; exit 1; }
```

The job checks out with full enough history (`fetch-depth: 0`) that `origin/staging` and `HEAD^2`
are both present; a shallow clone fails this step closed rather than passing it.

Why each line exists:

- `HEAD^2 == origin/staging` (exact equality to the *current* tip) is **not** used: re-running a
  valid promotion after staging advances would fail spuriously. Idempotent re-dispatch is a
  supported recovery, so the assertion is ancestry plus tree equality, not tip equality.
- Tree equality alone cannot catch a squash merge — squashing a fast-forwardable promotion produces
  an identical **tree**, so a tree-only check passes while `main`'s tip stops being an ancestor of
  `staging`. Requiring a real merge commit and checking `HEAD`/`HEAD^2` trees closes that.
- Line 3 binds the release to the commit that was **reviewed and is serving on staging**, not to
  `main~1`. If staging advanced and its live tree changed, the promotion fails and must be re-opened
  from the new tip.

**Freshness is checked under the lock, not while waiting for it.** A check taken after approval but
before the write lock can pass while a newer merge or staging deploy lands during the wait:

- After approval, the migrate job **acquires the per-target migration lock first** — the same lock
  break-glass uses. The wait is the window a pre-lock check cannot cover.
- Once the lock is held, it re-reads before any DDL: `main` head is still `github.sha`; staging's
  live commit is still the recorded `BASE` with no `deploy-staging` run in flight for a newer commit;
  and the pending hash set is unchanged, with the rehearsal still passing.
- Any difference releases the lock, refuses, and runs no DDL. A **confirmed supersession** (a newer
  `main` head or a newer staging deployment) is *benign*. An unreachable API, an unreadable
  `__drizzle_migrations`, or any hash set that cannot be read is a **verification failure** that
  fails closed — never benign, never a skip.
- Immediately **before the alias write**, the deploy job re-reads the same `main`/staging identity
  and the applied hash set. A confirmed change refuses benign without moving the alias; an
  unverifiable read fails closed with no alias move.

`deploy-production` serializes with `concurrency: deploy-production` and
`cancel-in-progress: false`, and the migrate job shares the per-target migration lock, so a second
promotion or a break-glass write cannot apply between the under-lock check and DDL.

Fixtures for #172/#173: merge during candidate verification; merge or staging deploy while the run
waits for the lock; break-glass holding the lock and applying a hash before the release acquires it;
an unavailable API or unreadable hash set reported as a verification failure rather than benign.

**Schema-free hotfixes.** A direct `hotfix/*` merge or push to `main` is not a merge of staging and
can never satisfy the promotion shape. The default remains: **all changes reach `main` through
`staging`.** If a direct emergency fix is unavoidable, it is two steps, not a `hotfix/*` ref
dispatch:

1. merge the reviewed, schema-free change to protected `main` through the normal merge path;
2. dispatch the reviewed `deploy-production.yml` on **protected `main`** for the current verified,
   merged `main` SHA, with `hotfix=true`. The workflow checks that the diff against the live commit
   **touches no `drizzle/` file**, still requires `production-migrations` approval, still verifies the
   candidate and live identity, and still uses the shared serialization.

A `hotfix/*` branch may exist for code review, but the deployment runs from `main`, because both
production environments are restricted to `main`. A schema change may never take this path. See
[guide 11](setup/11-actions-deploys.md) §4.

Fixtures for #172/#173: stale dispatch, re-run after staging advances, merge during candidate
verification, squashed promotion, back-merge, and schema-free hotfix accept/reject.

## 9. Migration guardrails

### Destructive-DDL lint (issue 4a, blocking)

For `drizzle/*.sql` added relative to the PR base, fail on `DROP`, `RENAME`,
`ALTER COLUMN … TYPE`, `SET NOT NULL`, and `ADD COLUMN … NOT NULL` without `DEFAULT`. Override
requires the `migration:breaking-approved` label (read via the API in CI, not from a cached event
payload).

The same script carries a **hotfix mode** that rejects *any* `drizzle/` change in a `hotfix/*` branch
or a `hotfix=true` dispatch.

**Why hotfixes are banned from touching `drizzle/`.** Two branches each run `drizzle-kit generate`:
both append to the single shared `drizzle/meta/_journal.json` with the next `idx` and a
generation-time `when`, and both emit `0010_<tag>.sql`. A hotfix merges its entry into `main` first,
then the promotion merges staging's entry at the *same* `idx`. The journal either conflicts (same
slot, different tag) or, resolved by concatenation, holds two `idx: 10` entries with non-monotonic
`when`.

The consequence is not an arbitrary apply order. On the `pg` driver, `drizzle-kit migrate` uses the
ORM PostgreSQL migrator, which considers a journal entry pending only when its `when` is **greater
than the maximum `created_at` already recorded** in `drizzle.__drizzle_migrations`, and applies the
pending set inside one transaction. A later-merged migration with an **older** `when` is therefore
**skipped**, and a duplicate `idx` can make the pending set disagree with the committed journal and
runtime manifest. Production then differs from staging: readiness reports `behind` or `diverged`
(the expected set includes a hash the database never got), and #74's manifest↔database parity check
fails. Skipped migrations are silent until readiness or the next deploy — which is exactly why the
ban is unconditional.

The same mechanism exists for two feature branches both adding `0010` — but there it surfaces as a
visible `_journal.json` conflict at PR-merge time and is fixed by rebase-and-regenerate. Only
`main`-bound paths make it invisible until promotion. The ban covers exactly the dangerous case.

Recovery for a hotfix that needs schema change: **none inside the hotfix**. Revert unready staging
work if necessary, and promote normally.

### Lock waits (issue 4b, blocked on #59)

`drizzle-kit migrate` (the `pg` path backed by the ORM PostgreSQL migrator) runs the **pending set
inside one transaction**, so `CREATE INDEX CONCURRENTLY` is **unsupported** — it cannot run inside a
transaction block. Document it; never attempt it.

Lock contention is bounded server-side on a dedicated migration role:

```sql
ALTER ROLE <migration_role> SET lock_timeout = '5s';
```

No aggressive `statement_timeout`: a legitimate index build on a small table should finish. Retry
happens in the workflow step (3 attempts, backoff, lock-timeout errors only), not in SQL.

This requires #59 (separate application and migration roles), which is therefore a **hard
prerequisite** for 4b, not a parallel nicety.

## 10. Per-PR preview databases (Phase 4)

Today, previews share whatever the Preview env scope provides. That is an **inference, not a
verified fact**: the repository proves a preview needs *a* database (`src/db/index.ts` throws
without one) and that `scripts/deploy.sh` refuses to merge without green preview readiness, but only
the Vercel dashboard can say whether every preview resolves to staging, to a separate preview DB, or
to a per-branch Neon URL. **The preview-readiness requirement is `deploy.sh` policy today, not a
branch-protection or ruleset check.** Changing or dropping it changes what that script does; it does
not alter branch protection.

Two rules follow:

1. **Previews must never migrate a shared database.** No `db-run` against `staging` from a PR
   context. If previews share staging, they read it and nothing else.
2. **Do not disable Vercel Git deployments until the replacement is proven**, and confirm
   empirically whether `deploymentEnabled` affects feature-branch previews at all.

If per-PR Neon branches are not proven end-to-end (runtime variable injection **and** cleanup),
the fallback is: remove the PR-preview readiness requirement and gate on CI plus the stable staging
deployment. **Removing the readiness requirement is a merge-signal change only — it does not remove
database access.** Take the fallback only with the guard decision in §7 state 3 in place (hosted
database credential removed from previews, or DB-backed previews disabled); otherwise unverified
previews keep using the unverified URL. That is an acceptable outcome, not a failure.

**Order:** #168's enforced guard decision lands **before** #171. The fallback and quarantine must be
available pre-#171; #176 (per-PR databases) may follow.

## 11. Spikes (unproven — do not implement until recorded)

**S1 — Vercel deploy semantics.** Hypotheses:
`git.deploymentEnabled` is keyed on the *deployed* branch, so `"staging": false` does not affect
feature-branch previews; and `vercel deploy --prebuilt --env KEY=value` is a build-time flag that
does **not** inject runtime env for a prebuilt deployment. Both are load-bearing for issues 6 and
10. One PR, one recorded result, written into `docs/setup/00-manual-setup-ui.md`.

**S2 — Per-PR Neon branch.** Hypothesis: a branch created per PR from staging can receive its own
pooled URL at runtime, be migrated, and be deleted on close, without polluting Vercel's dashboard
scope.

The Neon–Vercel integration is an **option, not the default**: it runs migrations inside the Vercel
build, which is the ordering this plan exists to prevent.

## 12. Phases and issue mapping

| Phase | Issues | Gate to start |
| --- | --- | --- |
| 1 — Identity and observability | 1, 8a, 4a, 2 | code-only; may start before the reading features finish |
| 2 — Migration safety | 3, 4b, 5 | 4b needs #59 |
| 3 — Actions as sole deployer | 6, 12, 7, 8b, 9 | S1 proven; Phase 0 inventory recorded; **3 and 4b landed** |
| 4 — Per-PR previews | 10 | S1 + S2 proven |
| 5 — Guardrails and docs | 11 (+ transitional note at 6) | **9** |

Dependency order: `1 → 8a → (4a, 2) → 3 → 4b(#59) → 5 → 6 → 12 → 7 → 8b → 9 → 10 → 11`.

Hard constraints, not sequencing preferences:

- **4a before or with 2** — the lint is the compensating control for tolerating `ahead`.
- **3 and 4b before 6** — `deploy-staging.yml` sets `APP_DEPLOY_ENV` and runs migrations; the
  environment-identity guard (3) and the migration-role `lock_timeout` (4b) must exist first, or the
  workflow ships without the guard it depends on. #171's body lists both.
- **8a with run-awareness before 7 goes live** — once the approval gate exists, every
  migration-bearing release produces a *designed* mismatch between branch HEAD and live commit.
  Without waiting-aware monitoring, the first such release pages you.
- **5 before 7** — the production rehearsal gate is part of the migrate job.
- **9 after 8b** — never retire the manual path before the monitor can see workflow-driven state.
- **Guard enforcement before 6** — #168 must *enforce* isolated preview routing, a verified read-only
  staging exception, or quarantine (no hosted database credential in previews) before #171. The
  fallback and quarantine are available pre-#171; per-PR databases (#176) may follow.
- **Freeze, then baseline, before dual deployers** — before either deployer is enabled, enter a
  freeze on **any** `drizzle/` change (not only added SQL), then record the stable verified
  deployment/alias and prove zero pending journal hashes with no schema-bearing diff live →
  candidate. Hold it across every overlap step, including the first post-flip merge. If the baseline
  is not neutral, stop and settle it on the legacy path before capturing a fresh one.
- **#175 splits**: script/merge retirement follows 8b; the `db-remote --pr` preview-preflight removal
  waits for 10 or its documented fallback. The first part does not wait on the second.
  **#177 depends on #175**, not merely "related" to it.

The **issue bodies and #178's tracker table are authoritative** for dependencies; this list exists to
name the orderings that are not obvious. When they disagree, fix the issue and the tracker — do not
let a prose line here silently override a missing dependency.

## 13. Cutover

Staging first, production second, nothing in one commit. During every overlap step, Vercel Git and
Actions can both deploy the same SHA — so the overlap is **frozen against any `drizzle/` change**
until the Actions deployment is proven to own the stable alias.

1. Merge Phases 1–2. Run the §10 cutover checklist in [guide 11](setup/11-actions-deploys.md).
2. **Enter the `drizzle/` freeze first:** no change of any kind under `drizzle/` — SQL,
   `meta/_journal.json`, snapshots; added, modified or deleted — on `staging` or `main`. Enter it
   **before** snapshotting the baseline and hold it through the first post-flip proof. Code-only
   merges are allowed.
3. **Record the stable verified baseline:** live commit, stable deployment ID/alias, `/api/version`
   state, and migration state. This is the value every later rollback and identity check refers to;
   a no-op merge is not a baseline.
4. **Prove the baseline is schema-neutral:** every journal entry is present in the live environment
   (zero pending hashes, no cutover-release exception), and `git diff <live-commit>
   <cutover-candidate>` over `drizzle/` is empty. If it is not neutral, **stop the cutover**: settle
   the pending migration through the legacy path, verify it, re-enter the freeze, capture a **fresh
   baseline**, and retry. Do not enable the second deployer against the old snapshot.
5. Merge `deploy-staging.yml` with Vercel Git deploys **still enabled**. Push a no-op commit. Confirm
   the workflow deploys it, `/api/version` reports that SHA, **and the Actions-created deployment ID
   owns `solara-stg.vercel.app`** — read the alias target, not just the served SHA, because Vercel
   Git may have produced a same-SHA deployment that owns it instead.
6. Only now flip `"staging": false` in `vercel.json`, in its own PR, and confirm the next merge still
   deploys via Actions and the alias still resolves to an Actions-created deployment ID.
7. **Prove one deployer before lifting the staging freeze:** the first post-flip merge produces
   exactly one new deployment, created by the workflow. If two appear, the flip did not take.
8. **Production stays on the legacy procedure until its own cutover.** Repeat steps 2–7 for
   production, in the same order, with its own freeze and fresh baseline. Do not apply staging's flip
   or freeze reasoning to production by assumption.
9. **Rollback drill.** Run [guide 11 §7](setup/11-actions-deploys.md#7-rollback-drill-acceptance-for-76)
   on production — both the matching-record revert and the withheld cases — and record the separate
   #76 evidence with run links.

If a deploy fails *after* `deploymentEnabled` is false, the recovery is `workflow_dispatch` on the
failed workflow, not `git revert` (a revert also needs a deployer). The first Actions deploy records
the existing stable deployment as the prior ID when one exists; only a genuinely absent alias skips
the revert cleanly, and the incident still opens. When the keyed record is absent or mismatched, or
the release carries the no-auto-rollback mark, the revert is withheld — see §4.

## 14. Consequences and accepted risks

- A tolerated `ahead` disables the automated rollback-compatibility signal. Accepted, mitigated by
  4a + expand/contract + time-bounded alerting.
- `main` can contain commits that are not live. That is now a reported state, not a hidden one.
- Schema-ahead remains visible forever, not just during a window.
- Staging is a content rehearsal, not a production-data rehearsal.
- Preview DB scope stays an inference until the dashboard is read; the boot guard (issue 3) makes a
  misconfiguration detectable rather than silent.

## 15. Definition of done

- [ ] Merging via the UI, `gh`, or an agent produces a gated, ordered, verifiable deploy with no
      local script involved.
- [ ] `/api/version` returns commit, tree, release, env, and migration state on both environments.
- [ ] Readiness is green during the migrate→deploy window and after an alias rollback.
- [ ] Production schema changes require the operator's approval and prior application on staging.
- [ ] Promotion PRs are merge-commit-only, enforced server-side, and a schema-free hotfix is merged to
      `main` then dispatched from `main` with `hotfix=true` rather than taking the promotion path.
- [ ] Candidates are verified before promotion; a failed release reverts to the recorded prior
      deployment ID only when the keyed record matches this prior ID, candidate SHA and applied hash
      set, and withholds the revert when the record is absent/mismatched or the no-auto-rollback mark
      is set. Candidate rejection, the matching revert and every withheld case are exercised in the
      guide 11 §7 drill (#76), with separate evidence.
- [ ] A preview cannot reach production, and previews never migrate a shared database; the preview
      guard enforces isolated routing, a verified read-only staging exception, or no database access
      (quarantined) before cutover.
- [ ] The monitor alerts on a stale live commit, a stuck `ahead`, and an approval waiting past its
      horizon — with a separate horizon for approval waits — and stays quiet for the designed
      waiting state before that horizon.
- [ ] Cutover proves, in the running configuration: a same-operator release of the
      `production-migrations` job (Prevent self-review OFF), that a waiting or denied approval is
      not a required status check or required deployment, and that the Actions deployment ID — not
      just the SHA — owns the stable alias.
- [ ] `docs/deploys.md` is frozen **at cutover** with a prospective header pointing at GitHub
      Deployments; historical rows are unchanged.
- [ ] Vercel and Neon dashboard state is recorded in `docs/setup/00-manual-setup-ui.md`.

## 16. Execution checkpoints (review before trusting unattended)

1. The issue 2 + ADR 012 diff — the readiness policy change.
2. Both spike results, before issues 6 and 10 are written.
3. **The first migration-bearing production promotion**, where three things meet for the first
   time: the approval gate, the SHA-fresh guard, and fail-closed migration detection. Read that run
   log line by line.
