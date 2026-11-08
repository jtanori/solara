# Plan — fix #52: schema provisioning + deploy gating

**Issue:** [#52](https://github.com/jtanori/solara/issues/52) · **Milestone:** M3 - Launch readiness (pending manual apply)
**Status:** ready to execute · **Owner:** repo owner (all steps are owner-only operations)
**Created:** 2026-11-08 · **Follow-up issues filed:** #59–#72 · **Epic / launch gate:** [#73](https://github.com/jtanori/solara/issues/73) · **Companion:** `docs/audit-database-integration.md` (why this happened), `docs/plan-neon-auth-migration.md` (separate decision)

---

## 1. Objective

1. Make staging and production **usable** (schema present, auth works) — *today*, **without** a code deploy.
2. Make a **missing or drifted schema impossible to deploy silently** — every existing gate becomes a real
   schema gate.
3. Leave an **auditable record** (issue comment) of what the databases actually contained, so future
   incidents have a baseline.

Non-goals: changing the auth provider, adding new features, retrofitting the legacy-`push` baseline
unless triage proves it is needed.

## 2. Working assumptions and ground rules

- **Never print a connection string.** Log only `host` + `current_database()` + counts.
- **Snapshot before DDL.** Neon branch of the target database (instant, copy-on-write).
- **No `drizzle-kit push`** anywhere. No DDL from the app at boot. No `--skip-migrate` for this fix.
- **Direct (non-pooler) URL** for migrations; **pooled** URL stays the app's runtime credential.
- The migration runner is **`migrate.yml`** (GitHub Environment `staging` / `production`), not a laptop,
  unless the owner explicitly decides otherwise for the emergency.
- **Two independent readings per environment** (app-side and DB-side) before declaring success.

## 3. Phases at a glance

| Phase | Goal | Time | Blocking |
|---|---|---|---|
| **P0** | Evidence: what is in staging/prod today | 20 min | — |
| **P1** | Unblock staging | 30 min | P0 |
| **P2** | Unblock production | 30 min | P1 green |
| **P3** | Guardrails (health gate, migrate assertion, mandatory dispatch, regression test) | 1–1.5 d | can start in parallel with P1 |
| **P4** | Docs + ops hygiene (backup/restore evidence, credential separation) | 0.5 d | P3 |

Total: **~2 days** elapsed, of which only ~1 hour is urgent.

---

## 4. P0 — Evidence (before touching anything)

### T0.1 Snapshot
```
Neon Console → project → Branches → "Branch" from target branch → name: pre-migrate-YYYYMMDD
```
Repeat for staging and production. Cost: nothing (copy-on-write). This is the rollback point.

### T0.2 Run the triage queries (read-only)

From a secure shell with the **direct** URL exported (never echo it):

```bash
psql "$DATABASE_URL_DIRECT" -v ON_ERROR_STOP=1 -c "
select current_database() as db, current_user as user, current_schema() as schema,
       inet_server_addr() as server_addr;" \
-c "
select count(*) as public_tables
from information_schema.tables where table_schema='public';" \
-c "
select table_schema, table_name from information_schema.tables
where table_schema in ('public','drizzle','neon_auth') order by 1,2;" \
-c "
select to_regclass('drizzle.__drizzle_migrations') as migration_table;"
```
If `drizzle.__drizzle_migrations` exists, also run:
```bash
psql "$DATABASE_URL_DIRECT" -c "select id, hash, created_at from drizzle.__drizzle_migrations order by id;"
```

### T0.3 Confirm the app points at *that* database
Vercel → Project → Settings → Environment Variables: record which scopes (Production / Preview /
Development) hold `DATABASE_URL`, and the **host** of each (host only, no credentials). Compare the
Production host with the host you just queried. A mismatch is a finding, not a detail.

### T0.4 Record it
Post to #52 (owner account, since the automation token cannot comment):

```
## Triage evidence (date)

| env | host | db | public tables | drizzle.__drizzle_migrations | neon_auth |
|---|---|---|---|---|---|
| staging | ep-…-pooler… | … | 0 | absent | absent |
| production | ep-…-pooler… | … | 0 | absent | absent |

Vercel DATABASE_URL scopes: Production=<host>, Preview=<host>, Development=<host>
Conclusion: <empty database | tables without history>
```

**Acceptance:** both rows filled in, with "empty" vs "legacy push" explicitly named.

**Decision point:** if any environment reports *tables but no migration history*, stop and go to
§8 (legacy baseline) instead of P1/P2 — running the baseline `CREATE TABLE` there will fail or corrupt.

---

## 5. P1 — Unblock staging

### T1.1 Apply the baseline (runner = `migrate.yml`)

```bash
gh workflow run migrate.yml --repo jtanori/solara \
  -f env=staging -f pr=<this-pr-number> -f sha=$(git rev-parse origin/main)
gh run watch --repo jtanori/solara $(gh run list --repo jtanori/solara --workflow=migrate.yml -L1 --json databaseId --jq '.[0].databaseId')
```
The workflow checks out `sha`, uses the `staging` Environment secret (direct URL), runs
`npx drizzle-kit migrate`, and creates `public.*` + `drizzle.__drizzle_migrations`.

Fallback (only if the workflow itself is broken): operator shell with the staging direct URL and
`npx drizzle-kit migrate` from a clean checkout of `main`. Record why the fallback was used.

### T1.2 Verify (DB side)
Re-run T0.2 on staging. Expected: `public_tables = 7`, `migration_table` present, one row
(`0000_initial`).

### T1.3 Verify (app side, staging)
```bash
curl -s https://solara-stg.vercel.app/api/health
# browser: sign up a throwaway user → dashboard → create a reading → open it → PDF → sign out → sign in
```

### T1.4 Verify (repo-side tooling, secret-safe)
```bash
node scripts/check-setup.mjs staging --strict
```

**Acceptance:** 7 tables + 1 migration row; sign-up/sign-in/create/PDF work on `solara-stg`; no `42P01`
in Vercel runtime logs for the last 15 minutes.

**Rollback:** restore the pre-migrate Neon branch into the staging branch, or drop the 7 tables
(the baseline created them on an empty DB, so nothing else is affected).

---

## 6. P2 — Unblock production

Same as P1 with `env=production`, plus:

- T2.0 Owner announces the window (production auth is already 100% broken; there is no user-facing
  regression to coordinate).
- T2.1 Snapshot `pre-migrate` on production (P0.1 already done).
- T2.2 Run `migrate.yml` with `env=production`.
- T2.3 Verify DB side, then app side on `solara-production.vercel.app`.
- T2.4 Confirm the real user who reported the error (`antunewenale@gmail.com`) can sign up or sign in.
  If they had an account, this migration creates an empty `users` table — **their account did not
  exist**, so tell them to sign up, not "try again".

**Acceptance:** same as P1 on production + the reporter's flow verified.
**Rollback:** Neon restore of the pre-migrate branch (only needed if DDL hit a non-empty DB).

---

## 7. P3 — Guardrails (the actual fix for *this class* of outage)

These are code changes and should land as **one PR** against `staging`.

### T3.1 `/api/health` becomes a schema gate
```ts
// src/app/api/health/route.ts
const REQUIRED = ["public.users","public.sessions","public.readings",
                  "public.knowledge","public.subscriptions"];
const missing = ...; // select to_regclass(k) for each; null ⇒ missing
if (missing.length) return Response.json({ ok:false, reason:"schema", missing }, { status:503 });
```
Rules: never leak the connection host; keep `select 1`; keep it fast (5 `to_regclass` calls in one
query); `cache: no-store`. A `503` **must** be what an unmigrated environment returns.

### T3.2 `migrate.yml` asserts the outcome
After `npx drizzle-kit migrate`, run the same probe and fail the job if it is not satisfied, plus:
```bash
psql "$DATABASE_URL" -tc "select count(*) from drizzle.__drizzle_migrations" # must be ≥ 1
```
Right now the workflow prints and exits 0 even if it migrated nothing.

### T3.3 Dispatch becomes mandatory, not diff-gated
`scripts/deploy.sh` currently does:
```bash
if git diff --name-only "$BASE_SHA...$HEAD_SHA" | grep -qE '^drizzle/'; then NEEDS_MIGRATE=true
```
Replace with an **always-run** pending-check for the target environment (read-only: compare journal
hashes with `drizzle.__drizzle_migrations`), and refuse the merge when the target is behind.
Keep `--skip-migrate` only behind an explicit `--force` + confirmation echo.

### T3.4 Regression test in CI
Reuse the Postgres service:
```bash
npx drizzle-kit migrate
curl -fsS localhost:3000/api/health | grep '"ok":true'
psql -c 'drop schema public cascade; create schema public;'
! curl -fsS localhost:3000/api/health   # must be 503
```
This is the test that would have caught the incident.

### T3.5 Remove the local false negatives
- Add a `db:check` script that works: `drizzle-kit check` **fails on our config today** with
  `Error: Please provide required params for AWS Data API driver` (verified locally, exit 1). Either
  drop the check in favour of T3.4 or drive it via `drizzle-kit diff`/SQL comparison.
- `scripts/check-setup.mjs` stays a format check, but its output must say loudly that it **does not
  connect** — and the runbooks must stop citing it as environment verification.

**Acceptance for P3:** on a throwaway Neon branch, `/api/health` returns 503 before migrating and
`{"ok":true}` after; a PR with no `drizzle/` change still blocks a merge when the target DB is behind;
CI fails if the schema probe fails.

---

## 8. Contingency — legacy `drizzle-kit push` database

If P0 finds tables without history:

1. `drizzle-kit pull` into a scratch schema to compare against `drizzle/0000_initial.sql`.
2. Write a reviewed **baseline script** that (a) verifies every expected object exists, (b) inserts the
   `0000_initial` hash row into `drizzle.__drizzle_migrations` — no `CREATE TABLE`.
3. Have a second person review the diff; run on staging first; keep the snapshot.
4. Never delete/rewrite migration history to make the command pass (already documented in
   `docs/setup/01-foundation-and-deployment.md`).

---

## 9. Ops hygiene to bundle into P4 (from the audit)

| Item | Why it matters now |
|---|---|
| Separate runtime credentials from migration credentials (Neon role without `CREATE`/`DROP`) | today the app's role can drop every table |
| Verify backup/PITR + run one restore drill | untested backups are not backups; nothing in the repo records a restore |
| Align secrets: one source of truth for `DATABASE_URL` (Vercel vs GitHub Environment) | divergence is exactly how you migrate the wrong database |
| Add `pool.on("error", …)` and an explicit `max` in `src/db/index.ts` | Neon autosuspend/idle drops emit unhandled pool errors; serverless × default `max:10` can storm connections |
| Pin `sslmode=verify-full`; drop the inert `channel_binding=require` from the docs | pg 8.20 treats `require` as `verify-full` and changes semantics in pg 9; `channel_binding` is not implemented |
| Document the preview-environment database mapping | preview code must never touch staging data |

---

## 10. Definition of done (mirror of the issue's acceptance criteria)

- [ ] Triage evidence for staging **and** production recorded in #52.
- [ ] 7 tables + `0000_initial` present in both environments.
- [ ] Real sign-up/sign-in end-to-end in both environments; reporter's flow confirmed.
- [ ] `/api/health` = 503 on an unmigrated throwaway branch, `{"ok":true}` on a migrated one.
- [ ] `migrate.yml` fails when the schema probe fails.
- [ ] A merge is blocked when the target DB is behind, regardless of the diff.
- [ ] CI has the drop-schema regression test.
- [ ] Docs (`01-foundation`, `00-manual-setup-ui`, `AGENTS.md`, `README`) describe the schema gate.
- [ ] `BACKLOG.md` row moved to Closed with the closing PR.

## 11. Timeline

| When | What |
|---|---|
| Now (≤1 h) | P0 evidence + P1 staging + P2 production → **auth is back** |
| +1 day | P3 guardrails PR merged to `staging` → `main` |
| +2 days | P4 hygiene + docs; issue closed with evidence links |
