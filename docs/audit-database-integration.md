# Audit — database integration: how "no tables" happened, and where we stand vs. the state of the art

**Date:** 2026-11-08 · **Branch:** `arena/8f0da984-solara` · **Related:** [#52](https://github.com/jtanori/solara/issues/52), `docs/plan-issue-52-database-provisioning.md`
**Scope:** read-only audit of the repo (`src/db`, `drizzle/`, `.github/workflows`, `scripts/`, docs). No infrastructure was touched. All product claims verified locally against the installed packages.

---

## 0. Answers up front

| Question | Answer |
|---|---|
| **How is it possible that no tables exist?** | `drizzle/0000_initial.sql` exists and is correct, but **nothing in the deployed app ever applies it**. The only hosted runner (`migrate.yml`) is `workflow_dispatch`-only, is dispatched **only when a PR diff touches `drizzle/`**, and has **never run** (`gh run list --workflow=migrate.yml` → `[]`). `drizzle-kit` is a dev dependency, `drizzle/meta` is excluded from the Vercel bundle: the deployed app *cannot* create its own schema by design. |
| **Are we using the actual database service at all?** | **Yes — Neon is genuinely wired up.** The app authenticates to a real Neon database and `select 1` succeeds (otherwise `/api/health` would have been red and deploys would have stopped). What we never used is its **schema-management surface**: no `drizzle-kit migrate` ever reached a hosted database, and Neon's own branching/PITR features are unused. So: *connected, authenticated, empty*. |
| **Are we handling the DB integration properly?** | **The design is good; the last mile is missing.** Versioned SQL migrations in git, Drizzle as the query layer, pooled vs direct URLs, separate staging/production — all correct. What is missing is the operational guarantee: nothing fails when the schema is absent, nothing separates runtime from migration credentials, nothing verifies backups, and the health endpoint is blind to schema. |
| **State of the art?** | Industry standard = **migrations are a CI/CD stage, not a manual step**: every environment's schema is applied by an automated job on merge/deploy, the deployment **verifies** the schema before declaring success, and runtime credentials cannot perform DDL. We have the artifacts of that model (migration files, a workflow, environments) but none of the enforcement. |

**Severity framing:** this is not an exotic bug. It is the classic *"migrations live in the repo, so we assume they ran"* failure — the same class as forgetting to run `npm run db:migrate` on a new server. The difference is that our health check, CI smoke, and deploy script were all incapable of noticing.

---

## 1. What the evidence says (verified, not inferred)

### 1.1 The migration infrastructure is real and correct

```
drizzle/0000_initial.sql     7 × CREATE TABLE, 4 × FK, 1 × index, gen_random_uuid() defaults
drizzle/meta/_journal.json   version 7, single entry { idx: 0, tag: "0000_initial" }
drizzle/meta/0000_snapshot.json  full schema snapshot (tables, columns, FKs, indexes)
```
- Verified the snapshot is **in sync** with `src/db/schema.ts`: running `npx drizzle-kit generate`
  prints *"No schema changes, nothing to migrate"*. So the schema definition and the migration are
  not the problem — someone would just have to run it.
- Verified the migrator is idempotent and self-bootstrapping
  (`node_modules/drizzle-orm/pg-core/dialect.js`: `CREATE SCHEMA IF NOT EXISTS drizzle`,
  `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations`, then one transaction per migration).
  Re-running is safe.

### 1.2 Nothing applies it in a hosted environment

| Path | What it does | Reaches Neon? |
|---|---|---|
| `.github/workflows/ci.yml` → `npx drizzle-kit migrate` | migrates the throwaway `postgres:16` service | **No** — localhost only |
| `.github/workflows/migrate.yml` | `npx drizzle-kit migrate` with Environment secret | **Yes, but never dispatched** (0 runs ever) |
| `scripts/deploy.sh` | dispatches it **only if** `git diff BASE...HEAD \| grep -qE '^drizzle/'` | Conditional — the only commit touching `drizzle/` on `main` is the baseline import (#51), which is not a PR |
| App runtime | no DDL, `drizzle-kit` is a devDependency, `.vercelignore` excludes `drizzle/meta` | No |
| `npx drizzle-kit push` | forbidden by policy, not present in any script | No |

So the schema arrives in a hosted environment **only** through a human remembering to run
`migrate.yml` on a PR that happens to touch `drizzle/`. Every PR so far touched docs, deploy scripts,
Vercel config, or AGENTS.md. Result: zero schema, forever.

### 1.3 Every verification layer was structurally blind

| Gate | What it checks | Would it catch "empty DB"? |
|---|---|---|
| `GET /api/health` (`src/app/api/health/route.ts:8`) | `select 1` | **No** — proves TCP + credentials only |
| `scripts/deploy.sh` post-merge poll | `/api/health` == `{"ok":true}` | **No** (inherits above) |
| CI smoke (`ci.yml`) | 404 gating on `/blueprint`, `/setup`, `/usage-guide` on the **CI** DB | **No** |
| `scripts/check-setup.mjs` | URL/format only — its own output says *"does not connect to providers"* | **No** |
| `scripts/check-remote-setup.mjs` | GitHub/Vercel settings, secrets presence | **No** |
| `migrate.yml` | prints the journal, runs migrate, exits 0 | Not even self-verifying |
| `npx drizzle-kit check` | **currently broken in this repo** (see 3.6) | **No** |

An empty database is therefore indistinguishable from a healthy one at every gate we own. The user
who reported the error was the first schema-aware check the system had ever run.

---

## 2. Is the Neon integration itself correct? (line-by-line)

### 2.1 What is right

- **`DATABASE_URL` only, no hardcoded credentials** — `src/db/index.ts` throws early if missing.
- **One pool, cached on `globalThis` outside production** — correct for Next dev HMR, and avoids a
  new pool per request in dev.
- **Pooled URL for the app / direct URL for migrations** — documented in
  `docs/setup/01-foundation-and-deployment.md`, `docs/setup/env-templates.md` and `compose.yaml`.
  This is exactly the recommended Neon split.
- **Transaction-mode compatibility acknowledged** — `src/lib/stripe-sync.ts:14` uses
  `pg_advisory_xact_lock(hashtext(...))`, which is only safe in transaction pooling; the docs call
  that out. Correct pairing.
- **Errors are handled lazily in queries, not at startup** — good for serverless cold starts, and the
  reason `42P01` surfaced at request time instead of crashing the build.
- **`gen_random_uuid()` defaults** come from PostgreSQL 13+ built-ins — no `pgcrypto` extension
  required on Neon. Verified in the SQL.

### 2.2 What is wrong or missing (ordered by blast radius)

| # | Finding | Evidence | Why it matters |
|---|---|---|---|
| **A** | **Runtime credentials can perform DDL.** The app and the migration runner share the same Neon role. | single `DATABASE_URL` per environment; no least-privilege role anywhere in docs/scripts | A compromised app (or an accidental `push`) can `DROP` production tables. Standard practice: app role with `SELECT/INSERT/UPDATE/DELETE` only, separate `migrator` role owning the schema. |
| **B** | **No connection lifecycle config.** `new Pool({ connectionString })` only — no `max`, no `idleTimeoutMillis`, no `pool.on("error")`. | `src/db/index.ts:16-18` | On Neon (autosuspend, scale-to-zero) idle connections are **terminated by the server**. Without an `error` handler, `pg` emits an unhandled `'error'` event → process-level noise/crashes. Default `max: 10` per lambda instance × concurrent lambdas is a direct route to `too many connections` against a pooled endpoint under load. |
| **C** | **TLS settings are inherited, not asserted.** `?sslmode=require` is parsed by `pg-connection-string` into `ssl:{}` (verified locally: `parse('…?sslmode=require') → {ssl:{}}`), and pg 8.20 prints: *"SECURITY WARNING: 'require'/'verify-ca' are treated as aliases for verify-full… in pg 9 this changes to weaker libpq semantics"*. | verified with installed `pg@8.20.0` | Today it is effectively `verify-full` (good), but the behaviour **changes silently on the pg 9 upgrade**. Pinning `sslmode=verify-full` removes the ambiguity. |
| **D** | **`channel_binding=require` in our docs is a no-op.** Neither `pg-connection-string` nor `pg` reads `channel_binding` (grep: no match in either package). TLS channel binding is only used by `pg` when the server negotiates `SCRAM-SHA-256-PLUS`. | `node_modules/pg-connection-string`, `node_modules/pg/lib/connection-parameters.js` | `scripts/deploy.sh` header and `docs/setup/env-templates.md` tell operators to add `&channel_binding=require`. It is harmless but **reads as a security control that does not exist**. Fix the docs, don't trust the flag. |
| **E** | **Health check is not a readiness check.** `/api/health` = `select 1`; no schema probe, no migration-state probe, and it is the *only* endpoint deploy/CI use. | `src/app/api/health/route.ts` | Root cause of the false green. (Fix = #52 P3.) |
| **F** | **No backup/restore evidence.** No PITR setting, no restore drill, no runbook output anywhere in the repo. | grep across `docs/` | On a free/launch Neon plan, history retention is limited. An untested restore is not a backup. |
| **G** | **Preview deployments have no explicit database mapping.** `.env.production.example` / `.env.staging.example` exist, but nothing states which `DATABASE_URL` a Vercel **Preview** build receives. Docs only say previews must never use production data. | `docs/setup/env-templates.md`, `00-manual-setup-ui.md` | If a preview inherits the staging variable (a common Vercel default), a branch preview will read and write staging data. Combined with (A), a preview bug can drop staging tables. |
| **H** | **Two sources of truth for the same secret.** `DATABASE_URL` lives in Vercel (runtime) and in GitHub Environments (migrations). Nothing compares them. | `deploy.sh` prereqs, `docs/setup/*` | The most likely future incident: migrate database X, run app against database Y. Mitigated only by a checklist. |
| **I** | **No indexing on hot paths.** `sessions` has no index on `expires_at`; `readings` has no index on `user_id`; `audit_logs` has no index on `created_at`/`actor_id`. `subscriptions.user_id` is the only non-PK index in the whole schema. | `drizzle/meta/0000_snapshot.json` | Fine at prototype scale, but the dashboard query (`readings WHERE user_id = ? ORDER BY created_at DESC`) will table-scan. Cheap to fix in the next migration. |
| **J** | **Expired sessions are never cleaned.** Logout deletes one row; nothing deletes expired rows. | grep: only `delete(sessions)` on logout | 30-day session TTL × all users, forever. Needs a periodic delete (cron or opportunistic). |
| **K** | **`npx drizzle-kit check` is broken in this repo.** With `DATABASE_URL=postgresql://…` it exits 1 with `Error: Please provide required params for AWS Data API driver: [x] database, [✓] secretArn: 'postgresql'` (reproduced locally, twice). | `drizzle.config.ts` lacks `driver`/`dbCredentials` refinement | Config is fine for `generate`/`migrate` but the `check` subcommand misparses it, so any runbook step relying on it fails. |
| **L** | **`.vercelignore` excludes `drizzle/meta`** — meaning a Vercel build could never run migrations even if someone wired it up (the journal is required). | `.vercelignore` | Correct decision (never migrate from a web host), but it is the reason "just run it at build time" is not an option, and it should be documented as such. |

### 2.3 Verdict on the integration

**Design: B+ / Operations: D / Observability: F.**
The code we wrote is conventional and, in places, better than average (transaction-pooling
awareness, pooled/direct split, no secrets in the repo, safe local seed guards). What is missing is
everything that happens *around* the code: enforcement, least privilege, readiness, restore drills,
and a single source of truth for the connection string.

---

## 3. State of the art (what "proper" looks like in 2026)

1. **Migrations are a pipeline stage, never a human step.** On merge to `staging`/`main` (or as a
   pre-deploy job) a controlled runner applies pending migrations to the target database, once per
   environment, with a lock (`concurrency` group — we already have that in `migrate.yml`).
2. **Deploy is gated on readiness, not liveness.** Liveness = process answers. Readiness = *the app can
   serve a real request*, which for a DB-backed app includes "the expected relations exist" and "the
   migration journal is current".
3. **Least privilege, two roles per environment.** `app` (DML only) for runtime; `migrator` (DDL) used
   only by the pipeline. Neon supports separate roles per database; the pooled URL given to the app
   should never be able to `DROP`.
4. **Expand/contract migrations** for zero-downtime: add nullable column → backfill → switch reads →
   drop later. Our two known future changes (adding `auth_user_id`, dropping `sessions`) fit this.
5. **Schema drift is detected, not discovered.** A CI job compares the migration journal with the
   target database (`drizzle-kit diff` / journal hashes) and fails the PR when deployment would be
   unsafe.
6. **Backups are tested artifacts.** PITR enabled, retention documented, one restore drill per
   quarter recorded with a timestamp; Neon branching is used as the cheap "restore rehearsal".
7. **The database is treated as branchable infrastructure.** Neon's copy-on-write branches give every
   PR/preview its own isolated DB — which also removes the "preview writes to staging" class of bug.
8. **Connection management is explicit.** Bounded pool per instance, statement/idle timeouts, a
   `pool.on('error')` handler, and a pooler-aware URL — mandatory for serverless + autosuspend.

Scored against that list, Solara today: **(1) partially (artifact exists, trigger doesn't), (2) no,
(3) no, (4) n/a yet, (5) no, (6) unknown/unrecorded, (7) no, (8) partially.**

---

## 4. Recommended follow-ups (beyond #52's fix)

These are **new, separate issues**, not part of #52. Epic index and launch gate: [#73](https://github.com/jtanori/solara/issues/73). Connection hygiene (finding D, the inert `channel_binding` flag) is tracked separately as [#61](https://github.com/jtanori/solara/issues/61). Ordered by value per hour:

| Priority | Follow-up | Effort |
|---|---|---|
| P1 | **Separate migration role from runtime role** (least privilege) + document grants — [#59](https://github.com/jtanori/solara/issues/59) | 0.5 d |
| P1 | **Readiness contract**: `/api/health` (liveness) + `/api/ready` (DB, schema, journal) — [#70](https://github.com/jtanori/solara/issues/70) | 0.5 d |
| P1 | **One source of truth for `DATABASE_URL`** + preview policy — [#63](https://github.com/jtanori/solara/issues/63) | 0.5 d |
| P2 | **Pool hardening**: `max`, `idleTimeoutMillis`, `pool.on('error')`, `statement_timeout` — [#60](https://github.com/jtanori/solara/issues/60) | 2 h |
| P2 | **Backup/PITR + one recorded restore drill** — [#62](https://github.com/jtanori/solara/issues/62) | 0.5 d |
| P2 | **Fix or delete `drizzle-kit check`**; real drift check in CI — [#64](https://github.com/jtanori/solara/issues/64) | 2 h |
| P3 | **Indexes** (`readings.user_id+created_at`, `sessions.expires_at`, `audit_logs.created_at`) — [#65](https://github.com/jtanori/solara/issues/65) | 2 h + migration |
| P3 | **Expired-session cleanup** — [#66](https://github.com/jtanori/solara/issues/66) | 2 h |
| P3 | **Preview database strategy**: per-PR Neon branch *or* explicitly no DB — [#63](https://github.com/jtanori/solara/issues/63) | 0.5 d |

---

## 5. Things I could not verify from here

- **Live database contents.** The sandbox has no egress to Vercel/Neon (`curl` exits 35), so the
  "zero tables" conclusion rests on code + workflow history, not on a query result. T0.2 in the plan
  produces that proof — it is the first thing to run.
- **Vercel env var scoping** (which scopes hold `DATABASE_URL`) — needs the dashboard or a token with
  project read access.
- **Neon plan, region, PITR retention, autosuspend settings** — dashboard only.
- **Whether the reporting user ever had an account** — if the DB is empty, they could not have; treat
  the report as "sign-up is broken", not "my account vanished".

## 6. Sources

- Drizzle ORM — migrations fundamentals (`generate`/`migrate`/`push`/`pull`):
  <https://orm.drizzle.team/docs/migrations>
- Drizzle migrator behaviour verified in the installed package
  (`node_modules/drizzle-orm/pg-core/dialect.js`: `CREATE SCHEMA IF NOT EXISTS drizzle`,
  `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations`, transactional apply).
- `pg@8.20.0` + `pg-connection-string` behaviour verified locally (sslmode parsing, no
  `channel_binding` support, deprecation warning text).
- Repo evidence: `drizzle/*`, `.github/workflows/{ci,migrate}.yml`, `scripts/deploy.sh`,
  `scripts/check-setup.mjs`, `src/db/index.ts`, `src/app/api/health/route.ts`,
  `docs/setup/01-foundation-and-deployment.md`, `docs/setup/env-templates.md`.
