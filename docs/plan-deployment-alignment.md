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
| Migrations are never run by `drizzle-kit` directly against a hosted DB outside that delegation. | no `drizzle-kit` reference in `.github/workflows/*` |
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
                                                                                   └─ failure: re-promote previous
drift-monitor (8a/8b): branch HEAD ≠ live, or migrations state stuck  ─► alert
```

## 4. Failure semantics

Every failure leaves production serving something valid, and says so.

| Fails at | Database | Live site | Signal |
| --- | --- | --- | --- |
| build | untouched | previous build | red run + incident issue |
| migrate | partially applied at worst; `lock_timeout` aborts the statement cleanly | previous build (schema `ahead`, tolerated) | red run + issue |
| candidate verify | migrated | previous build; candidate never promoted | red run + issue |
| post-promote verify | migrated | previous build re-promoted (alias only) | red run + issue |
| approval declined | untouched | previous build | run `waiting` → cancelled |

**"Merged but not live" is a first-class state**, reported by the drift monitor, not inferred from
email.

### What auto-revert does and does not mean

- It **re-promotes the previous Vercel deployment** (an alias move). It never runs a down migration
  and never reverts database state.
- If migration succeeded and deployment failed, the schema stays. Report the release as failed and
  fix forward, or roll back application code only once compatibility is established.
- The alias path is the one part of the current tooling that has never run against the live API.
  #76's acceptance is a real drill, and [Phase 3.7](#37-cutover-staging-then-production) step 5 is
  that drill.

## 5. Verification: identity, not readiness

`/api/ready` answers "can this build serve?". It cannot answer "is the build I intended actually
serving?" — the old deployment returns `{"ok":true}` quite happily.

`/api/version` (Phase 1) reports:

```json
{ "commit": "3f2a…", "tree": "9c41…", "release": "…", "env": "production",
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

`buildReadiness` moves from set equality to four states:

| State | Meaning | Readiness |
| --- | --- | --- |
| `exact` | applied == expected | ok |
| `ahead` | applied ⊃ expected (extras are newer) | **ok** |
| `behind` | expected ∖ applied non-empty | fatal |
| `diverged` | applied ∖ expected contains an older or unknown entry | fatal |

No numeric cap on `ahead`. The cap provided no safety — a fourth unknown migration is no more
dangerous than a second — and every extra knob becomes a test matrix. The bound is **time**:
`/api/version` reports `ahead` indefinitely, and the drift monitor alerts after 20 minutes.

**This removes the last automated signal that a rollback is schema-incompatible.** Today
`unexpected > 0` is fatal, which is how an operator learns that rolling back the application is
unsafe. After this change, a rolled-back build reports green. The compensating controls are:

1. a **blocking** destructive-DDL lint on every PR that adds `drizzle/*.sql` (issue 4a);
2. expand/contract discipline for breaking changes (issue 11);
3. persistent `ahead` reporting plus a time-bounded alert (issue 8a).

Issue 4a must merge before or with this change. That is an ordering constraint, not a preference.

`/api/ready` also stops reporting `ok:false` during the migrate→deploy window and after an Instant
Rollback. Both are currently outages by construction.

## 7. Environments, secrets, and identity

### GitHub Environments

| Environment | Holds (names only) | Protection |
| --- | --- | --- |
| `staging` | `DATABASE_URL` (staging, direct), `VERCEL_*`, `VERCEL_AUTOMATION_BYPASS_SECRET` | branch `staging` only |
| `production` | `VERCEL_*`, `VERCEL_AUTOMATION_BYPASS_SECRET` | branch `main` only |
| `production-migrations` | `DATABASE_URL` (production, direct), `DATABASE_URL_STAGING_READONLY` | branch `main` only, **required reviewer: operator, Prevent self-review OFF** |

`staging` and `production` already exist with no protection rules. `production-migrations` is new.

Why the split: code-only deploys go out automatically; anything that changes the production schema
pauses for the operator, even when an agent merged it.

**Governance note.** Environment protection is a *deploy* gate, not a *merge* gate: it delays a
workflow job, never a merge. It does not create a catch-22 under `docs/PR_WORKFLOW.md` §0 because
the operator is already the sole merge authority — a contributor is never blocked waiting for a
second human. §0 records this exception explicitly; without it, a future agent will read the rule
and delete the gate.

### Environment identity guard (issue 3)

One module, used at app boot, in `db-run.ts`, and in `drizzle.config.ts`:

| `APP_DEPLOY_ENV` | DB endpoint must be |
| --- | --- |
| `production` | equals `PROD_DB_ENDPOINT` |
| `staging` | equals `STAGING_DB_ENDPOINT` |
| `preview` | neither (per-PR branch; see the preview caveat) |
| `local` | loopback |

Endpoint = first hostname label with `-pooler` stripped. Pooler hosts are rejected for migration
URLs. Fail closed on unknown.

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

Two assertions, deliberately separated:

1. **What staging serves is what we promote** — required PR check:
   `tree(staging live commit from /api/version) == tree(PR head)`, and no in-flight
   `deploy-staging` run.
2. **Merge-commit-only** — enforced post-merge, server-side, as the first step of
   `deploy-production.yml`:

   ```bash
   STAGING_TIP=$(git rev-parse origin/staging)
   [[ "$(git rev-parse HEAD^2 2>/dev/null)" == "$STAGING_TIP" ]] ||
     { echo "ERROR: main tip is not a merge commit of staging"; exit 1; }
   ```

Tree equality alone cannot catch a squash merge: squashing a fast-forwardable promotion produces a
commit whose **tree is identical**, so check (1) passes while `main`'s tip stops being an ancestor
of `staging`, degrading every later promotion diff and back-merge.

Check (1) is early signal only. A `deploy-staging` run can start or finish between the check passing
and the merge. The workflow re-asserts both conditions server-side and fails closed.

## 9. Migration guardrails

### Destructive-DDL lint (issue 4a, blocking)

For `drizzle/*.sql` added relative to the PR base, fail on `DROP`, `RENAME`,
`ALTER COLUMN … TYPE`, `SET NOT NULL`, and `ADD COLUMN … NOT NULL` without `DEFAULT`. Override
requires the `migration:breaking-approved` label (read via the API in CI, not from a cached event
payload).

The same script carries a **hotfix mode** that rejects *any* `drizzle/` change in a `hotfix/*` PR.

**Why hotfixes are banned from touching `drizzle/`.** Two branches each run `drizzle-kit generate`:
both append to the single shared `drizzle/meta/_journal.json` with the next `idx` and a
generation-time `when`, and both emit `0010_<tag>.sql`. A hotfix merges its entry into `main` first,
then the promotion merges staging's entry at the *same* `idx`. The journal either conflicts (same
slot, different tag) or, resolved by concatenation, holds two `idx: 10` entries with non-monotonic
`when`. `db-run` compares hashes, not `idx`, so apply order follows array order — production can
apply migrations in an order staging never used, and the runtime manifest no longer corresponds to
`drizzle.__drizzle_migrations` insertion order (#74's parity check).

The same mechanism exists for two feature branches both adding `0010` — but there it surfaces as a
visible `_journal.json` conflict at PR-merge time and is fixed by rebase-and-regenerate. Only
`main`-bound paths make it invisible until promotion. The ban covers exactly the dangerous case.

Recovery for a hotfix that needs schema change: **none inside the hotfix**. Revert unready staging
work if necessary, and promote normally.

### Lock waits (issue 4b, blocked on #59)

`drizzle-kit migrate` wraps each migration in a transaction, so `CREATE INDEX CONCURRENTLY` is
**unsupported** — document it, do not attempt it.

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
without one) and that a merge is blocked without green preview readiness, but only the Vercel
dashboard can say whether every preview resolves to staging, to a separate preview DB, or to a
per-branch Neon URL.

Two rules follow:

1. **Previews must never migrate a shared database.** No `db-run` against `staging` from a PR
   context. If previews share staging, they read it and nothing else.
2. **Do not disable Vercel Git deployments until the replacement is proven**, and confirm
   empirically whether `deploymentEnabled` affects feature-branch previews at all.

If per-PR Neon branches are not proven end-to-end (runtime variable injection **and** cleanup),
the fallback is: remove the PR-preview readiness requirement and gate on CI plus the stable staging
deployment. That is an acceptable outcome, not a failure.

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
| 3 — Actions as sole deployer | 6, 12, 7, 8b, 9 | S1 proven; Phase 0 inventory recorded |
| 4 — Per-PR previews | 10 | S1 + S2 proven |
| 5 — Guardrails and docs | 11 (+ transitional note at 6) | 9 |

Dependency order: `1 → 8a → (4a, 2) → 3 → 4b(#59) → 5 → 6 → 12 → 7 → 8b → 9 → 10 → 11`.

Two orderings are hard constraints, not sequencing preferences:

- **4a before or with 2** — the lint is the compensating control for tolerating `ahead`.
- **8a with run-awareness before 7 goes live** — once the approval gate exists, every
  migration-bearing release produces a *designed* mismatch between branch HEAD and live commit.
  Without waiting-aware monitoring, the first such release pages you.

## 13. Cutover

Staging first, production second, nothing in one commit.

1. Merge Phases 1–2.
2. Merge `deploy-staging.yml` with Vercel Git deploys **still enabled**. Push a no-op commit; confirm
   the workflow deploys it and `/api/version` reports that SHA. Double-deploying is the price of not
   having a bootstrap hole.
3. Only now flip `"staging": false` in `vercel.json`, in its own PR, and confirm the next merge still
   deploys via Actions.
4. Repeat for production, with the same "prove it, then disable" order.
5. **Rollback drill.** Force a post-promote failure behind an env flag. Confirm the candidate gate
   blocks promotion, the alias returns to the previous deployment, and readiness reports `ahead` or
   `exact` afterwards — never `unexpected`-fatal.

If a deploy fails *after* `deploymentEnabled` is false, the recovery is `workflow_dispatch` on the
failed workflow, not `git revert` (a revert also needs a deployer).

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
- [ ] Promotion PRs are merge-commit-only, enforced server-side.
- [ ] Candidates are verified before promotion; a failed promotion re-promotes the previous
      deployment. Both exercised in a drill (#76).
- [ ] A preview cannot reach production, and previews never migrate a shared database.
- [ ] The monitor alerts on a stale live commit, a stuck `ahead`, and an approval waiting too long —
      and stays quiet for the designed waiting state.
- [ ] `docs/deploys.md` is frozen with a header pointing at GitHub Deployments.
- [ ] Vercel and Neon dashboard state is recorded in `docs/setup/00-manual-setup-ui.md`.

## 16. Execution checkpoints (review before trusting unattended)

1. The issue 2 + ADR 012 diff — the readiness policy change.
2. Both spike results, before issues 6 and 10 are written.
3. **The first migration-bearing production promotion**, where three things meet for the first
   time: the approval gate, the SHA-fresh guard, and fail-closed migration detection. Read that run
   log line by line.
