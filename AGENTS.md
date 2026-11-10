# AGENTS.md — Solara Operator & Agent Guide

> **Read this first** if you are a contributor or an autonomous agent working in this repository. This file is the daily operating manual; durable rationale lives in [`docs/decisions.md`](docs/decisions.md) and the offline backlog index in [`BACKLOG.md`](BACKLOG.md).

**Source of truth:** [GitHub Issues](https://github.com/jtanori/solara/issues) are authoritative for work. `BACKLOG.md` is a convenience snapshot (see ADR 002). Decisions are ADRs in `docs/decisions.md`. The launch gate is `README.md` + `docs/setup/README.md`.

---

## 1. Repository Map

```
solara/
├── src/
│   ├── app/                    # Next.js App Router (/, /blueprint, /setup, /usage-guide, /verify-email, /api/*)
│   ├── components/             # UI, site-header/footer, usage-guide.tsx, verify-email-*
│   ├── lib/                    # passwords, rate-limit, mail, email-verification, request-security, security-headers, billing
│   ├── proxy.ts                # central origin guard + CSP nonce
│   └── db/                     # Drizzle schema, pg client
├── drizzle/                    # versioned migrations + meta (never push to prod)
├── tests/                      # tsx --test suites (usage-guide-access, passwords, billing, geocoding, solar)
├── scripts/
│   ├── check-setup.mjs         # secret-safe format check: node scripts/check-setup.mjs [local|staging|production] [--strict]
│   ├── db-run.ts               # env-explicit migrate/status/verify; rejects wrong targets
│   ├── generate-migration-manifest.ts # regenerate/check the runtime migration manifest
│   ├── report-rate-limits.ts   # hashed rate-limit state for operators (npm run rate-limits:report)
│   ├── cleanup-rate-limits.ts  # delete expired rate-limit rows (npm run rate-limits:cleanup)
│   ├── local/seed-users.ts     # local-only guarded seed: 9 accounts + subscriptions (ALLOW_LOCAL_SEED)
│   └── verify-gating-production.ts # prod-mode gating verifier: 404 + role scoping + payload leak checks
├── docs/
│   ├── decisions.md            # ADRs 001-008 (006 identity, 007 auth hardening, 008 migrations/deploy)
│   └── setup/                  # 01-foundation, 02-stripe, 03-maps, 04-pdf, 05-i18n, 06-astro, 07-validation, 08-auth-security
├── BACKLOG.md                  # offline index — last updated staging@9a57fab / main@03467bd (PR #47 sync)
├── .github/
│   ├── workflows/ci.yml        # verify job: migrate → typegen → tsc → eslint → tests → audit → build → smoke
│   ├── dependabot.yml          # npm + github-actions, target-branch: staging
│   └── pull_request_template.md
├── .env.example                # never commit real secrets (.gitignore: .env, .env.*)
├── .env.staging.example / .env.production.example # templates for Vercel Preview/Production
└── package.json                # scripts: dev, build, start, lint, typecheck, test, db:seed:local, rate-limits:report/cleanup
```

**Where to look first:**
- Setup/deployment: `docs/setup/README.md` → `01-foundation-and-deployment.md` (branching, Neon/Vercel, migrations, runbooks).
- Manual click-path for #1/#2: `docs/setup/00-manual-setup-ui.md`.
- Env scoping: `docs/setup/env-templates.md`.

---

## 2. Local Setup (verified 2026-11-07 on Node 22 / PG 16)

```bash
# 0. Prereqs: Node 22, npm, Git, PostgreSQL 16 (or disposable Neon branch)
# Create a new, empty, disposable PG database — never reuse prod data.

# 1. Env (copy only if .env doesn't exist)
cp .env.example .env   # fill DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_db + APP_URL=http://localhost:3000

# 2. Install + migrate + dev
npm ci
npx drizzle-kit migrate          # uses DATABASE_URL from .env (or exported)
npm run dev                      # http://localhost:3000 → /api/health = {"ok":true}; /api/ready = full readiness

# 3. Secret-safe check (never prints values)
node scripts/check-setup.mjs local
# strict for hosted:
# DATABASE_URL=<pooled> APP_URL=https://... node scripts/check-setup.mjs staging --strict

# 4. Verify (use disposable DB host localhost/127.0.0.1/::1 only)
npx next typegen
npm run typecheck                # tsc --noEmit
npm run lint                     # eslint src tests scripts --max-warnings=0
RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts
npm run build                    # next build — run before any PR
npm run db:manifest:check        # runtime migration manifest matches drizzle/
npm run db:check                 # schema + journal + unexpected applied hashes
# Local email defaults to MAIL_TRANSPORT=outbox and writes .mail-outbox/*.eml.
# Rate-limit state is hashed; inspect or prune it with:
npm run rate-limits:report
npm run rate-limits:cleanup

# 5. Local seed (never in staging/prod, never set these in Vercel)
ALLOW_LOCAL_SEED=true LOCAL_SEED_PASSWORD='a-strong-local-password-12+' \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_db \
  npm run db:seed:local          # idempotent 9 accounts: owner/admin/editor/user + 5 subscription fixtures
# CI uses ALLOW_LOCAL_SEED_IN_CI=true on 127.0.0.1 (see ci.yml step 13)

# 6. Prod-mode gating spot-check (optional, mirrors CI)
npm run build && PORT=3000 npx next start &
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db APP_URL=http://localhost:3000 ALLOW_LOCAL_SEED_IN_CI=true \
  npx tsx scripts/verify-gating-production.ts  # unauth 404s, role-scoped single guide, ?role= ignored, no payload leak
```

**Never:** `drizzle-kit push` on staging/prod, commit real `DATABASE_URL`/`STRIPE_*`/mail keys, set `ALLOW_LOCAL_SEED*` in Vercel, use `MAIL_TRANSPORT=outbox` outside local development, or reuse prod secrets locally.

---

## 3. Security Invariants (non-negotiable)

- **Secrets:** `.env`, `.env.*` are gitignored (`.gitignore: .env, .env.*`). Templates are `.env.example`, `.env.staging.example`, `.env.production.example` — placeholders only. Store real secrets in Vercel env manager / Neon dashboard, scoped per env (see `docs/setup/00-manual-setup-ui.md`). Never log `DATABASE_URL`.
- **Auth:** Public signup = `user` (free). Owner is provisioned only via privileged `psql`:
  ```sql
  \set owner_email 'owner@example.com'
  UPDATE users SET role='owner' WHERE email=lower(:'owner_email') RETURNING id,email,role;
  ```
  No bootstrap endpoint. All `hasPremiumAccess` checks are server-side via `src/lib/billing.ts` (active/trialing = true, past_due/expired/canceled = false).
- **Health/readiness:** `/api/health` is liveness only and must not touch the database. `/api/ready` checks DB, required tables/indexes/columns, migration manifest, and auth-table access with a 250ms connect/statement bound; returns `503` and `Cache-Control: no-store`, never hostnames, URLs, or versions.
- **Account claim:** sign-up collects name/email only, creates no session, and returns a generic response for new and existing addresses. The mailbox owner claims the account by choosing a password via a fragment token; claim revokes all sessions and invalidates sibling tokens. Unverified accounts cannot sign in. Never backfill legacy accounts as verified.
- **Auth throttling:** `/api/auth` serializes per-IP and per-account attempts in IP → account order; counters, password verification, and session creation share the transaction (`src/lib/rate-limit.ts`, `src/lib/account-lock.ts`). Ten account failures trigger progressive 30s-to-15m backoff; IP ceilings are 100 all-attempts and 50 failures per 15m. Scrypt uses a four-slot pool with a bounded queue; saturation returns a generic 503. Returns `429` + `Retry-After`; never reveal whether an email exists. Logs must never contain emails, IPs, hashes, or passwords.
- **Email delivery:** tokens are SHA-256 hashed at rest, single-use, 24h TTL, with a 60s resend cooldown (`src/lib/email-verification.ts`). Tokens live in the URL fragment and are submitted only by the explicit claim POST. Delivery runs in `after()`; retain the prior token until a new message is delivered, keep both on ambiguous outcomes, discard the new token only on definitive rejection, and keep it if finalization fails after acceptance. Finalization is generation-aware and uses user → token lock order; claim uses the same order. Verified accounts cannot receive or redeem another claim token. Hosted environments require a canonical HTTPS `APP_URL`. Local mail uses `MAIL_TRANSPORT=outbox` and `.mail-outbox/`; staging/production require Resend or Postmark. Never log a token.
- **Password reset:** `password_reset` tokens are hashed, single-use, 1h TTL, and delivered only to verified accounts. Confirmation revokes all sessions and writes an `audit_logs` `password:reset` row. Requests and confirmations are rate-limited; never reveal whether an email exists.
- **Places:** `/api/places` requires same-origin, 30/min/IP, bounded same-query cache, four upstream slots, and `PLACES_HOURLY_BUDGET`. The key and upstream URL are never logged.
- **Database pool:** `src/db/index.ts` sets `DB_POOL_MAX` (default 5), idle/connection/statement timeouts, an error listener, and normalized `sslmode=verify-full` for all hosted modes; `disable`/`ssl=false` are rejected.
- **Mutating routes:** `src/proxy.ts` centrally rejects cookie-authenticated `POST/PUT/PATCH/DELETE` under `/api/*` unless the complete `Origin` (scheme, host, port) matches a trusted origin or `Sec-Fetch-Site: same-origin`. Exemptions: Stripe webhook (signature) and CSP reports. There is no Bearer exemption until a validated bearer flow exists. The matcher has a dedicated `/api/:path*` entry, so asset-looking API paths cannot skip the guard.
- **Logging:** server code logs only through `src/lib/log.ts`; bare `console.*` is an ESLint error. Do not pass an `Error`, query, request body, or birth data object to a logger. Extract a redacted message/SQLSTATE, include the `x-request-id` on errors and rate-limit/backoff warnings, route path (never query), and a UUID `userId` only. Redaction strips emails, tokens, database URLs, Bearer values, Stripe/mail keys, long hex/base64, and sensitive keys (`password`, `token`, `secret`, `email`, `birth`, `stripe`, `authorization`, `cookie`).
- **Security headers/CSP:** `src/lib/security-headers.ts` owns HSTS, frame/referrer/permissions/nosniff headers, authenticated `Cache-Control: private, no-store`, and the nonce CSP allowlist. `CSP_MODE=report-only` until a clean observation window, then `enforce`. Extend the allowlist in code and document it in `docs/setup/08-auth-security-hardening.md`.
- **Seed guard:** `scripts/local/seed-users.ts` and `scripts/verify-gating-production.ts` refuse non-loopback `DATABASE_URL` and `CI/VERCEL/VERCEL_ENV` unless `ALLOW_LOCAL_SEED_IN_CI=true` (CI disposable `127.0.0.1`).
- **Internal documents:** `/blueprint` and `/setup` → `404` outside `NODE_ENV=development` (guarded by `src/lib/development.ts`). `/usage-guide` outside dev: unauth → `404`; signed-in sees only their role's single guide (`free`/`premium`/`editor`/`admin`/`owner`), `?role=` ignored, header/footer/dashboard links hidden (see `src/app/usage-guide/page.tsx`, `src/lib/usage-guide-access-core.ts`).
- **Customer data:** Never use real data, live Stripe keys, or prod DBs in previews/local. Managed prod DB requires TLS, backups, PITR, least-privilege creds (see ADR 005).

---

## 4. Branching & Deployment (ADR 001 + #2)

**Model:** `feature → staging → main`
- **Long-lived:** `main` (Vercel Production) and `staging` (Vercel Preview, stable `staging.*` domain) — both protected (see `gh api repos/jtanori/solara/rulesets` → `protect-main`, `protect-staging`).
- **Feature:** branch from `staging` as `<type>/<issue>-<slug>` (e.g. `feat/8-local-seed-scaffold`, `chore/6-dependabot`).
- **Flow:** `feature` (squash PR) → `staging` (QA on `solara-stg.vercel.app`) → promotion `staging → main` (merge commit, **not** squash — ADR 004) → Vercel production. Deploy via `scripts/deploy.sh` (handles `drizzle/` migrations **before** merge via `migrate.yml`).
- **Naming examples:** `docs/3-agents-guide`, `chore/6-dependabot`, `feat/10-stripe-lifecycle`.

**Protection (applied 2026-11-07):**
- Require PR, status check `verify`, conversation resolution, block force-push/deletion.
- `staging`: linear history required. `main`: linear history **not** required (merge commits allowed for promotions).
- Approvals: `0` on both while single collaborator (bump `main` to `1` when 2nd maintainer joins).
- Repo settings: **squash + merge commit** for promotions, **auto-delete head branches** (`gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'` → `{true,true,false,true}` — squash for features, merge for promotions).

**Environments (target, see `docs/setup/00-manual-setup-ui.md` for UI clicks):**
- **Staging:** Neon project `solara-staging` (pooled `DATABASE_URL` for Vercel Preview → `staging` branch; direct for `npx drizzle-kit migrate`), Vercel Preview env (`APP_URL=https://staging...`, Stripe **test** keys), isolated previews.
- **Production:** Neon `solara-prod` (pooled + direct, backups/PITR), Vercel Production env (`APP_URL=https://...`, Stripe **live** keys).
- Secrets scoped per env in Vercel; `NEXT_PUBLIC_*` baked at build → redeploy after change.
- Migrations: generate with `npx drizzle-kit generate --name=...` (review SQL + meta), run `npm run db:manifest`, test on fresh DB + staging, and apply through `db-run`/`migrate.yml` before code deploy (`push` forbidden on prod). See ADR 008.

**Verify:** `node scripts/check-setup.mjs staging|production --strict` + `GET /api/health` (liveness) + `GET /api/ready` (DB/schema/migrations/auth) + `RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts`.

**Deploy gate:** `scripts/deploy.sh` runs a read-only hosted `db-remote --check --env <env> --branch <reviewed-ref>` before merge, then requires `/api/ready` after merge. Protected Vercel environments need `VERCEL_AUTOMATION_BYPASS_SECRET`; missing or 401/403 is a hard failure. `db:check` is local drift; `db:check:remote` is the hosted dispatch.

---

## 5. PR & Commit Protocol (ADR 004)

- **Reviews:** COMMENT-only until 2nd maintainer (author cannot approve own PR — GitHub blocks it). Protection requires `0` approvals but **conversation resolution** — all review comments must be resolved.
- **A review exists only if it is on the PR** — a `COMMENT`-event review via `POST /pulls/<n>/reviews`, anchored inline comments, and the reviewed SHA in the body. A review pasted into chat, held in another workspace, or applied as uncommitted fixes is **not a review**: it cannot be resolved, audited or enforced. Fixes land as commits on the PR branch so CI runs on them. Mechanics, checklist (SEC-01…SEC-07), severity levels and suggestion-block format: [`docs/CODE_REVIEW.md`](docs/CODE_REVIEW.md).
- **Test quality (SEC-07):** for any test that claims to guard a defect, break the code deliberately and watch it fail. A test that passes under mutation is decoration — this is the failure mode that produced #97 and #112.
- **Merge:** **squash** for `feature → staging` (one commit per feature, `Closes #X` on its own line each — GitHub only closes the first if comma-separated). Promotions `staging → main` are **merge commit** (preserves `staging` ancestor — see ADR 004).
- **Commits:** Conventional style, no secrets, `DATABASE_URL` never in message. Example:
  ```
  docs: add AGENTS.md operating guide (#3)

  Closes #3
  ```
- **Template:** use `.github/pull_request_template.md` (Summary, Linked issues, Evidence `tsc`/`eslint`/`tests`/`build`/smoke, Risk, Rollout/Rollback).
- **CI gate:** `mergeStateStatus` must be `CLEAN`, `verify` green (1m15s-1m38s) + GitGuardian pass. Vercel and GitGuardian are **advisory** — only `verify` is a required status check, so a failing preview does not block a merge.
- **Evidence, not adjectives:** the PR body's Evidence section takes command output or a CI link. **Never claim a check passed that was not run**; a check that could not run is reported as unrunnable, not omitted.

---

## 6. Backlog Conventions (ADR 002)

- **GitHub Issues are authoritative.** `BACKLOG.md` is an offline index — `Last updated: staging@9a57fab / main@03467bd (PR #47 sync)`. Update it only when issues are created/changed/closed.
- **Labels:** `type:*`, `area:*`, `priority:p1/p2/p3`, `status:ready/blocked/needs-triage`.
- **Open (2026-11-07):** `#6` Dependabot (ready), `#10` Stripe lifecycle (ready — unblocked), `#16` validation (needs-triage). Closed recent: `#1 branching`, `#2 deployment`, `#3 AGENTS.md`, `#4,#5,#7,#8,#9,#11,#12,#13,#14,#15,#17-#23`.
- **How to add work:** create GitHub Issue first, then add row to `BACKLOG.md` with link `#<n>`.
- **How to close:** close GitHub Issue, move row to “Closed” table with closing PR/commit (e.g. `| [#5] | ... | #23 (2176a15) |`).

---

## 7. Decisions to Know

- **ADR 001** Branching `feature → staging → main` (Settings → General + Rulesets).
- **ADR 002** `BACKLOG.md` is index, not source of truth.
- **ADR 003** Platform-validation checklist is pre-launch gate (astro, hist TZ, editorial versioning, backup/restore, MFA/CSRF/rate-limit).
- **ADR 004** COMMENT-only reviews + squash (promotions excepted).
- **ADR 005** Prototype gate — not production-ready; no live billing/real data until checklists green.
- **ADR 006** Identity: keep local auth through launch; Neon Auth only via superseding ADR and security review.
- **ADR 007** Auth and transport hardening for launch.
- **ADR 008** One migration path; migrate before deploy; rollback is code/forward-fix/restore, not down migrations.

Full text: [`docs/decisions.md`](docs/decisions.md). Review mechanics: [`docs/CODE_REVIEW.md`](docs/CODE_REVIEW.md).

---

## 8. Agent Checklist (copy for each PR)

- [ ] Branch from `staging` as `<type>/<issue>-<slug>`.
- [ ] `npm ci`, `npx drizzle-kit migrate` (if new migration), `npx next typegen`, `npm run typecheck`, `npm run lint`, `RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts`, `npm run build`, `npm run db:manifest:check`, `npm run db:check` — paste evidence.
- [ ] No secrets in diff, `.env` not committed, `ALLOW_LOCAL_SEED*` not in Vercel.
- [ ] `BACKLOG.md` updated if issues opened/closed.
- [ ] PR body: `Closes #X` per line, Evidence, Risk, Rollout/Rollback.
- [ ] CI green (`verify` + GitGuardian) and `mergeStateStatus: CLEAN`.
- [ ] Any review is **posted to the PR** (`COMMENT` event, inline findings, reviewed SHA named) — not pasted into chat.
- [ ] For each test guarding a defect: mutation run, and the result recorded in the PR body.

*Keep this file current — it is the contract for the next agent.*
