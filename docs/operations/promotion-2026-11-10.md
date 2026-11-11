# Promotion runbook — `staging → main` (2026-11-10)

> **Note (2026-11-10):** `BACKLOG.md` was removed from the repository in favour of an on-demand,
> gitignored snapshot — see **ADR 009** and #132. References to it below describe the state at the
> time of writing.

> **Superseded in part (2026-11-10, later):** the operator confirmed production has **no accounts**
> ("everything is new"), the mail provider is **Resend**, and `deploy.sh` can be run with Vercel
> access. HAZARD A in §1 is therefore a **no-op on an empty database**, and the mitigation below is
> not needed. Current sequence: `production-bootstrap-2026-11-10.md`.

Status: **prepared, not dispatched.** Steps marked **[HUMAN]** cannot be executed by an agent.
Prepared against this session's branch `arena/4b7f8e03-solara` (= `staging@750a272`), `main@4490ced`.
Authority: `docs/operations/production-migration-gate.md`, ADR 004, ADR 008.

---

## 0. Why this promotion needs its own runbook

This is not a routine promotion. Three facts change the sequence:

1. **`main` is not an ancestor of `staging`,** so `scripts/deploy.sh` **refuses this PR before
   merging**. Replayed against the real refs:
   ```
   merge-base --is-ancestor origin/main origin/staging -> exit 1
   BEHIND=5
   trial merge-tree -> exit 0 (conflict-free)
   => ERROR: refusing to deploy a conflict-free stale PR — update the branch first.
   ```
   The new base-freshness gate (#124) has no override by design. A **back-merge PR
   `main → staging` must land first.**
2. **Production has never been migrated.** All 11 `migrate` runs in repository history are staging.
   The last production provisioning attempt was the #52 incident, which closed by provisioning
   *staging only*; #52's own resolution says production is still unprovisioned. So the first
   production `migrate` will create the **entire schema** `0000 → 0003`, not just the three new
   migrations.
3. **Production has no observability.** #77 is open, so a failure is discovered by a user report,
   as #52 was. Rollout cannot be watched; it must be verified by polling `/api/ready`.

### The good news, verified

- The back-merge is a **pure ancestry commit, zero file changes.** Main has nothing staging lacks:
  `git diff origin/staging...origin/main` is empty, and the trial merge tree is byte-identical to
  `origin/staging`'s tree (`703022d`). So the back-merge is free and reviewable in a minute.
- **Only additive DDL.** `0001` creates `rate_limits` (+1 index); `0002` creates `email_tokens`
  (+1 index), adds nullable `users.email_verified_at`; `0003` creates `generation_cache` and
  `reading_documents` (+1 unique index). No table, column or index is dropped anywhere in the diff
  (`git diff --diff-filter=D` is empty).
- The migrate workflow gate markers all exist for this ref (`mode`, `dry_run`,
  `migration-applied.json`, `mode=migrate`, `dry=false`).
- `zod@4.6.7` is the only new runtime dependency.

---

## 1. [HUMAN] Read this before approving: two migration hazards

Reviewing `.sql` is the one control the gate cannot mechanise, so these go first.

### HAZARD A — `0002` deletes every session

```sql
DELETE FROM "sessions" WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "email_verified_at" IS NULL);
DELETE FROM "email_tokens" WHERE "used_at" IS NULL;
```

`users.email_verified_at` is added **in the same migration**, so it is `NULL` for every existing
row. The first statement therefore deletes **all sessions belonging to every pre-existing user**.

Blast radius is now wider than before, because `src/lib/auth.ts` also requires verification:

```ts
isNotNull(users.emailVerifiedAt),   // in the session lookup
```

So an unverified account cannot hold a session at all. Existing users are silently logged out and
must complete the email-verification flow (which needs a working mail transport, `MAIL_TRANSPORT`
+ `RESEND_API_KEY`/`POSTMARK_SERVER_TOKEN`). **If mail is not configured, those users are locked
out with no self-service recovery.**

- On **staging** this already happened and is accepted.
- On **production** it is the first migration, so it is a policy decision, not a technical one.
  Current production accounts are prototype/test data (ADR 005 says no real customers), so the
  decision is probably "acceptable" — but it should be **recorded as a choice**, not discovered.

Cheapest mitigation if it is not acceptable: `UPDATE "users" SET "email_verified_at" = now();`
immediately after migration `0002` applies and before the deploy, so existing prototype accounts
keep their sessions. That is a data change, so it needs your explicit sign-off per ADR 008.

### HAZARD B — the deploy is not instant, so the schema must be readable by old code

ADR 008 requires new code to tolerate the previous schema **and** the previous code to tolerate the
new one (expand/contract). Migrate-before-deploy means the currently-live `main` build runs against
an already-migrated production database for the window between step 5 and Vercel's rollout.

I could not verify two things from this sandbox and **you must confirm them**:

- **The live production build's `/api/ready` behaviour.** `main` (deployed 2026-11-07) predates the
  schema-verification / readiness work entirely. `src/lib/schema-verification.ts` now requires
  `users.email_verified_at`, `rate_limits.*` and `email_tokens.*`. If the old build's `/api/ready`
  checks a similar list, it will begin failing **immediately after migration and before deploy**,
  which looks like the deploy broke and is not.
- **The live production build's auth behaviour.** `main` loads user rows without an
  `email_verified_at` filter; the new build requires verification. Between migration and rollout the
  two populations disagree. Harmless for a prototype, but if you plan to keep any seeded account,
  verify it before the merge, not after.

**Vercel URL is not reachable from this environment** (`https://solara-production.vercel.app` →
HTTP `000` via every path, including the bypass header), so `deploy.sh`'s post-merge `/api/ready`
gate **will fail closed** if run from here. Steps 6–7 below must run somewhere with network access
to Vercel, or `deploy.sh` must be given the bypass secret and a reachable URL.

---

## 2. New environment variables the deploy needs

Failing closed on any of these is the intended behaviour, so treat them as deploy prerequisites.

| Variable | Needed by | Failure mode if unset |
|---|---|---|
| `MAIL_TRANSPORT`, `MAIL_FROM`, `RESEND_API_KEY` *or* `POSTMARK_SERVER_TOKEN` | #54 verification, #55 reset, HAZARD A | `MailConfigurationError`; verification and reset are dead |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_MXN`, `STRIPE_PRICE_ID_USD` | #125, billing | checkout/webhook fail |
| `CSP_MODE` | #57 | defaults to `report-only` (correct for now) |
| `READINGS_GENERATION_ENABLED` | #127 | defaults to **false** — pipeline ships dark, no action needed |
| `DB_POOL_MAX` | #60 | uses a conservative default |

`OPEN_METEO_API_KEY` / `PLACES_*` back the hardened `/api/places` (#84) — confirm the key is set in
production *before* the deploy, because the hardened proxy fails closed where the old one did not.

Run the repo's own check: `node scripts/check-setup.mjs production --strict`.

---

## 3. The sequence

### Step 1 — back-merge `main → staging`

Branch: `chore/promote-sync-main`, base `staging`, **merge commit** (`--merge`, not squash; ADR 004).

```bash
git fetch origin main staging
git switch -c chore/promote-sync-main origin/staging
git merge --no-ff origin/main -m "chore: back-merge main into staging (promotion prerequisite)"
git push origin chore/promote-sync-main
gh pr create --base staging --head chore/promote-sync-main \
  --title "chore: back-merge main into staging (promotion prerequisite)" \
  --body-file <(cat <<'EOF'
## Summary
`main` is not an ancestor of `staging`, so `scripts/deploy.sh`'s base-freshness gate (#124)
refuses the promotion PR. This back-merge restores ancestry so the promotion can be gated.

**Zero file changes, verified:** `git diff origin/staging...origin/main` is empty and the trial
merge tree `703022d` is identical to `origin/staging^{tree}`. The five commits brought in are
merge commits already represented on staging.

Closes nothing. Prerequisite for the `staging → main` promotion.

## Evidence
- [x] `git diff --stat origin/staging...origin/main` → empty
- [x] `git merge-tree --write-tree origin/staging origin/main` → tree identical to staging
- [x] CI `verify` on the new head
EOF
)
```

Wait for `verify` green and `mergeStateStatus: CLEAN`, then **`--merge`** (squash would flatten
staging's history and break the next ancestry check, and `protect-staging` requires linear history —
confirm the merge-commit PR is accepted; if the ruleset rejects it, use a single squashed
"sync" commit instead and note the deviation in the promotion PR — ancestry is satisfied either way).

> Alternatively use the repo's own script: `./scripts/deploy.sh --pr <n> --env staging`, which
> enforces every gate for you. It requires a full clone (not shallow).

### Step 2 — open the promotion PR

Branch: `chore/promote-staging-to-main`, base **`main`**, head **`staging`** (or a frozen promotion
branch — see the note at the end). Body: use `docs/promotion-pr-body.md`.

Open it, then **do not push to it again.** The gate freezes its head SHA in step 3.

### Step 3 — [HUMAN] freeze and rehearse the exact SHA

Run the procedure from `docs/operations/production-migration-gate.md` §"The procedure", steps 1–4.
It is already correct and I have deliberately not paraphrased it. What it will do:

1. Freeze `PROMO_REF` + `PROMO_SHA` (full 40-char).
2. Assert the workflow at that ref has `mode`, `dry_run` and the four gate markers — **verified
   present** at `750a272`.
3. Re-check that the head did not move.
4. Dispatch a **staging rehearsal**: `env=staging, pr=$PROMO_PR, sha=$PROMO_SHA, mode=migrate,
   dry_run=false`, and confirm the run is named
   `migrate staging pr-<n> <SHA> mode=migrate dry=false` with `migration-applied.json` in the verdict
   artifact. Without this record, the production gate has nothing to cite and will fail closed.

Note the last staging rehearsal on record is `pr-127 @ e9d0abd`, **not** this promotion SHA — a new
rehearsal is mandatory, so this step cannot be skipped on the grounds that "staging already ran it".

### Step 4 — [HUMAN] production schema

```bash
npx tsx scripts/db-remote.ts --pr "$PROMO_PR" --env production --rehearsal-pr "$PROMO_PR"
```

This is a **`migrate` (DDL), not a `verify`** — production has no schema at all, so read the output
as "creating 7 tables + 4 indexes", not "applying 3 migrations". The gate clauses 1–6 all apply and
fail closed.

Take a Neon snapshot/branch of `solara-prod` first if it holds anything you would miss.

### Step 5 — [HUMAN] confirm schema, then deploy

```bash
# must print: OK production schema and drizzle journal are in sync
npx tsx scripts/db-remote.ts --check --env production --branch "$PROMO_REF" --sha "$PROMO_SHA"

# merge + rollout + /api/ready gate (needs Vercel reachability + bypass secret)
./scripts/deploy.sh --pr "$PROMO_PR" --env production --skip-migrate
```

`--skip-migrate` is correct **only** because step 4 already did the DDL. Re-running `migrate` is
idempotent but it re-runs gate clauses for no benefit; if you prefer belt-and-braces, drop the flag.

`deploy.sh` will merge with `--merge` (preserves ancestry), wait on Vercel status for the merge SHA,
then require `/api/ready -> {"ok":true}`.

### Step 6 — verify, then reconcile the tracker

- `curl -fsS -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" https://solara-production.vercel.app/api/ready` → `{"ok":true}`
- `node scripts/check-setup.mjs production --strict`
- manual: sign-up, sign-in, verify-email, password-reset round trip — **this is the only real proof
  that HAZARD A resolved**, because `/api/ready` only checks schema presence.

Then, on promotion only (per ADR/backlog policy), these close **only if** their code is confirmed
live on production; until then they correctly stay open:

`#53 #54 #55 #56 #57 #60 #61? #64 #70 #72 #78 #84 #87 #103 #119` and `#117 #101 #102` (already fixed).

Update `BACKLOG.md` in the same PR that closes them (it is stale: it has no entry for #126, #127,
#128, #129, #130).

---

## 4. What I could not verify from this sandbox

| Item | Status |
|---|---|
| Vercel production reachability | **unreachable** (HTTP 000). Steps 5–6 need a networked operator. |
| Production database state | **no** `DATABASE_URL` for production here, and it is correctly Environment-scoped. Absolute confirmation that prod is empty requires `--env production --check`, which needs the gate's environment. |
| Production Vercel env vars | not readable from here — `check-setup.mjs production --strict` is the check to run. |
| GitHub Environment protection rules | both `staging` and `production` report `protection_rules: 0`. Per `production-migration-gate.md` this is **intentional** for a single-maintainer repo, not a gap. Do not "fix" it. |
| Real provider / consent gate | `READINGS_GENERATION_ENABLED` stays false, so readings are dark in this promotion. Fine. |

## 5. Stop conditions

Do not proceed past step 3 if:
- the promotion PR head moved after freezing (re-freeze and rehearse the new SHA),
- the staging rehearsal run is not `mode=migrate dry=false` with `migration-applied.json`,
- `db-remote --check --env production` does not report in sync,
- you cannot reach `https://solara-production.vercel.app` to satisfy the `/api/ready` gate — an
  unverified rollout is worse than a delayed one, and with #77 open there is no other signal.

## 6. Follow-ups this promotion exposes

File these; they are real gaps, not wishes:

1. **#77 before the second production deploy.** First deploy has zero error tracking.
2. **`protect-main` sets `strict_required_status_checks_policy=true`.** Every staging merge makes a
   promotion PR stale, requiring another back-merge. That is the structural cause of this runbook
   existing; consider a scheduled `main → staging` sync or dropping strict for promotions only.
3. **A dry-run rehearsal path for the first migration of a brand-new database.** The gate assumes
   "staging already ran it", which is true per-migration but does not describe a first-ever apply.
4. **#128 + #129** (readings accounting) — cheap, and they are open against code shipping here.
   They do not block promotion because the pipeline is dark.
