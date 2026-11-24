# Promotion assessment — `staging` → `main` (2026-11-24)

Read-only assessment of what PR #230 would land, and what must be configured before it can merge
cleanly. Supersedes the *facts* in `promotion-2026-11-10.md` (that runbook remains valid for its
sequence; its "prepared, not dispatched" state still holds).

Verified with `git` and the GitHub API on **2026-11-24**. Nothing here was executed against
production.

---

## 1. The promotion is currently blocked — two failing checks

PR #230 (`staging` → `main`) reports `MERGEABLE` but **`verify` and `pr-lint` both fail**, so
`mergeStateStatus` is not `CLEAN` in the sense that matters. `protect-main` requires `verify`.

### Blocker A — the destructive-DDL gate fails on `0008`

`verify` stops at its **first** step, *Migration safety (destructive DDL)*:

```text
npx tsx scripts/check-migration-safety.ts   # PR_NUMBER=230
```

Every migration is `added` in this PR (all 9 arrive at once), so all 9 are scanned. Eight are purely
additive. **`drizzle/0008_paid_annual_facts.sql` contains 4 `DROP` statements:**

```sql
ALTER TABLE "paid_reading_attempts" DROP CONSTRAINT "paid_attempts_section_check";
ALTER TABLE "paid_reading_runs"     DROP CONSTRAINT "paid_runs_contract_check";
ALTER TABLE "paid_reading_runs"     DROP CONSTRAINT "paid_runs_manifest_check";
ALTER TABLE "paid_reading_runs"     DROP CONSTRAINT "paid_runs_state_check";
```

`src/lib/migration-safety.ts:84` flags any statement matching `\bDROP\b` as destructive. The only
override is the label **`migration:breaking-approved`** (`BREAKING_LABEL`, line 9), which produces
`status: "override"` and lets the step pass.

These four are a **drop-then-recreate of CHECK constraints in the same file** — the new definitions
follow immediately, widening the allowed `section` and `profile` values. Not data loss. But the gate
is deliberately conservative and cannot tell, so the decision is a human one recorded as a label.

**Fix:** add `migration:breaking-approved` to PR #230 after reviewing the drop/re-add pairs, or
restructure `0008` to `ALTER CONSTRAINT … NOT VALID`/re-validate (a migration rewrite, and it has
already been applied on staging — do not rewrite an applied migration).

> **Why this went unnoticed.** `0008` merged to `staging` in its own PR (#151, commit `ec5e17e`),
> which would have hit the same gate and must have carried the label or been reviewed under a
> different diff shape. The check is per-PR-diff, so a promotion that re-presents the file as
> *added* is scanned afresh.

### Blocker B — `pr-lint` fails on missing body sections

Advisory (not a required check), but it is red. `scripts/pr-lint.mjs` requires the literal headings
`## Linked issue` and `## Evidence` in the PR body; PR #230 has neither. Title and `type:*` label are
fine.

**Fix:** add both sections to the body.

### Consequence of Blocker A: the promotion is otherwise unverified

Because the migration gate runs first and fails, CI **skipped** `db:manifest:check`, `tsc`,
`eslint`, the full test suite, `npm audit` and `next build`. Verified locally at `9447f36`:
`db:manifest:check` clean, `tsc` 0, `eslint` 0. The **full build was never run in CI for this
diff**, so clearing the label is the first time `next build` executes against the combined tree.

---

## 2. What actually lands

`git diff --shortstat origin/main origin/staging` → **471 files, +92,167 / −2,435**.
`main` holds 117 files; `staging` holds 515. This is not a feature bump — it is the first time the
product reaches `main`.

| Area | Change |
| --- | --- |
| **Migrations** | `0001`–`0009` added (`main` has only `0000_initial`) — 9 files |
| `src/readings` | 86 files — the paid/editorial readings pipeline |
| `src/lib` | 47 files — readiness (ADR 012), auth hardening, schema verification, drift monitor |
| `src/app` | 35 files — `/api/ready`, `/api/version`, billing, account, admin |
| `src/db` | `boot-guard.ts`, `url-guard.ts`, `index.ts`, `schema.ts` |
| `.github/workflows` | `ci.yml`, `migrate.yml`, **new** `drift-monitor.yml` |
| `drizzle/` | 9 migrations + `meta/` snapshots + `_journal.json` (10 entries) |
| Deploy tooling | `scripts/deploy.sh` + 7 `scripts/lib/*` helpers |
| `package.json` | new scripts, `zod`, chromium/canvas for PDF |

`main` today has **no `/api/ready`**, no `src/lib/readiness.ts`, no `src/lib/schema-verification.ts`,
and no `drizzle/` beyond `0000`. Its `/api/health` is a bare `select 1`.

---

## 3. Database migrations — the real risk

### 3.1 Production has never been migrated

Live evidence, not inference:

- **Every `migrate.yml` run in repository history targets `staging`.** 15 most recent runs checked;
  zero production. `production-readiness-audit-2026-11-10.md:79` says the same for all 11 runs at
  the time.
- **Zero production deployments, ever.** `GET /repos/jtanori/solara/deployments?environment=production`
  → `0`; every GitHub Deployment in the repo is `staging` (21 of them).
- `promotion-2026-11-10.md` is marked **"prepared, not dispatched."**

So the first production migrate applies **`0000 → 0009`**, creating the entire schema — not 9
incremental migrations and not the 4 the November runbook anticipated.

### 3.2 The gate requires a rehearsal

`migrate.yml` accepts `env: production` only with **`rehearsal_pr`** set to the PR number already
migrated on staging for the same change; it fails closed if absent. Because `staging`'s current
schema was applied across many PRs (#127, #142, #151, #156 @ `b6b6d01`), the rehearsal for this
promotion must be the PR that most recently migrated staging at the SHA being promoted — they are not
the same number. Determine the pair before dispatch.

### 3.3 `0002` deletes every pre-existing session

```sql
DELETE FROM "sessions"   WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "email_verified_at" IS NULL);
DELETE FROM "email_tokens" WHERE "used_at" IS NULL;
```

`email_verified_at` is added **in the same migration**, so it is `NULL` for every existing row and
the first statement removes every session belonging to every pre-existing user. `src/lib/auth.ts`
additionally requires verification in the session lookup, so unverified accounts cannot hold a
session at all.

If production has no accounts (`production-bootstrap-2026-11-10.md`: *"Production accounts: None.
Everything is new."*), this is a **no-op**. That must be confirmed rather than assumed — it is the one
statement in the diff that destroys data on a non-empty database.

Optional mitigation, a **data change needing explicit sign-off** (ADR 008): run
`UPDATE "users" SET "email_verified_at" = now();` after `0002` and before deploy.

### 3.4 Take a Neon snapshot first

ADR 008: no down migrations. Recovery is a forward fix or a point-in-time restore.

---

## 4. The Vercel deployment race — status

The convergence race was addressed by **ADR 012** (`docs/decisions.md:375+`), which replaced exact
migration-set equality with four states: `exact`, `ahead`, `behind`, `diverged`. That is implemented
in `src/lib/readiness.ts` and reachable at `/api/ready`.

**It is not yet live**, because `main` has none of it. Two consequences:

1. **The race cannot occur on this promotion.** `main`'s live build checks only `select 1`; it has no
   schema verification, so it will not 503 when the database gains 9 migrations. The
   "expected readiness skew" window is harmless here. After this lands, ADR 012 governs it.
2. **Rollback stops being free.** Per ADR 012, a Vercel Instant Rollback after a migration restores
   availability but never readiness — a rolled-back build lacks the new hashes. `decide_rollback` in
   `scripts/lib/deploy-policy.sh` already refuses auto-rollback for non-production and requires
   credentials, a target and `env=production`. Recovery for a bad promotion is a forward fix or a
   restore, not a reopened pre-migration deployment.

### 4.1 What actually deploys production

`docs/setup/11-actions-deploys.md:18` claims `main` deploys via `deploy-production.yml`. **That
workflow has never existed** — `git log --diff-filter=A` finds no such file, and the repo has only
`ci.yml`, `migrate.yml`, `drift-monitor.yml`. Merging to `main` therefore triggers **Vercel's Git
integration**, not GitHub Actions. There is no `/api/ready` gate on that path; the monitor is the
only post-deploy check, and it does not exist on `main` yet.

That doc row is wrong and should be corrected.

---

## 5. Two additional blockers for a *deploy*

Clearing the migration label lets PR #230 **merge**. It does **not** make production healthy.

**A. Cached `DATABASE_URL` / stale env snapshot.** Production env vars were set at a point in time.
Vercel deployments keep the env snapshot they were created with; a moved or rotated production
`DATABASE_URL` will not reach an existing deployment.

**B. `deploy.sh` refuses this PR shape.** Its base-freshness gate (#124) has no override:

```
merge-base --is-ancestor origin/main origin/staging  -> exit 1
=> ERROR: refusing to deploy a conflict-free stale PR — update the branch first.
```

A **back-merge PR `main → staging`** must land before `deploy.sh` will consider a promotion. The
November runbook's Step 1 covers this. It is a pure ancestry commit — `main` has nothing `staging`
lacks except `BACKLOG.md`, whose removal is correct (ADR 009).

---

## 6. Pre-merge checklist

| # | Item | Status |
| --- | --- | --- |
| 1 | Add `migration:breaking-approved` to #230 after reviewing `0008`'s drop/re-add pairs | **required** |
| 2 | Add `## Linked issue` and `## Evidence` sections to #230's body | **required** |
| 3 | Let `verify` run to completion (`next build` has never run on this tree) | **required** |
| 4 | Confirm production has no accounts (makes `0002`'s session delete a no-op) | **required** |
| 5 | Neon snapshot of `solara-prod` | **required** |
| 6 | Identify the staging rehearsal PR number for the promoted SHA | **required** for `migrate.yml` |
| 7 | Confirm production env vars: mail, Stripe, Places, `DB_POOL_MAX` | **required** for a working deploy |
| 8 | Back-merge `main → staging` if `deploy.sh` will be used | required for `deploy.sh`, not for the merge |
| 9 | Correct `11-actions-deploys.md:18` (it names a workflow that does not exist) | recommended |

## 7. Recommended sequence

1. Clear blockers 1–3; wait for a fully green `verify`.
2. Back-merge `main → staging` (restores ancestry, makes `deploy.sh` willing).
3. Verify 4–7.
4. Dispatch the production migrate with `rehearsal_pr` set, `dry_run: true` first, then for real.
5. Merge #230 (merge commit, ADR 004 — never squash a promotion).
6. Poll `/api/ready`; expect `exact`.
7. Confirm `drift-monitor` then runs from `main` and its pending verification completes
   (`docs/operations/drift-monitor-setup-runbook.md` §5e).
