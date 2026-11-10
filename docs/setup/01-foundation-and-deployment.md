# 1. Foundation, database and deployment

## What is implemented

Next.js App Router runs on Node.js with PostgreSQL through Drizzle. The app reads `DATABASE_URL`; `drizzle.config.ts` reads the same variable. The repository contains the initial migration in `drizzle/` and CI in `.github/workflows/ci.yml`. CI uses an isolated PostgreSQL service, applies migrations, checks types/lint, runs tests, audits production dependencies and builds.

The application pool is explicitly bounded (`DB_POOL_MAX`, default 5, max 20) with 30s idle and 10s connection timeouts, a 15s statement timeout, and an error listener. Hosted URLs should use `sslmode=verify-full`; the application normalizes every hosted `sslmode` other than `verify-full` (including absent, `require`, `prefer`, `verify-ca`, `no-verify`, and `allow`) to `verify-full`, removes an ambiguous `ssl` flag, and rejects `disable`/`ssl=false`. Local loopback URLs keep their existing form. `pg@9` changes the meaning of `require`, so the explicit normalization is intentional.

Branching is `feature → staging → main` (see `docs/decisions.md` ADR 001). `main` (production) and `staging` are intended to be long-lived protected branches at `166539f` — **target, not yet protected** (see verification below); feature branches are short-lived from `staging` as `<type>/<issue>-<slug>`, squash-merged with auto-delete (target).

## Branching and merge policy

- **Long-lived:** `staging` (from `main` at `166539f`) and `main` — *target: protected; **Status: not applied yet*** — no rulesets (`gh api repos/jtanori/solara/rulesets` → `[]`), `branches/staging/protection` → 403. Apply via Settings → Branches → Rulesets or `gh api` with admin PAT.
- **Naming:** `<type>/<issue>-<slug>` (e.g. `feat/13-usage-guide-role-scope`). Target: prohibit direct pushes to `staging`/`main` (status: not applied yet).
- **Repo settings (target, not applied):** squash-only merge, auto-delete head branches (Settings → General → Pull Requests). Current API shows `allow_squash_merge:true`, `allow_merge_commit:true`, `allow_rebase_merge:true`, `delete_branch_on_merge:false` — requires manual toggle to `allow_squash_merge:true` only.
- **Protection — `staging` (target, not applied):** PR required, status check `verify` (migrations, `next typegen`, `tsc`, `eslint`, `tsx --test`, `audit`, `build` + smoke 404s), conversation resolution, linear history, block force-push/deletion, required approvals `0` (single collaborator).
- **Protection — `main` (target, not applied):** same as `staging`, but required approvals deferred to `1` once a second maintainer exists. Today `0`; self-approval is blocked by GitHub (author cannot approve own PR) but merge is allowed because protection requires `0`.
- **Flow:** `feature → staging` (reviewed PR) → QA on staging → promotion PR `staging → main` → Vercel production.

## Local setup

1. Install Node.js 22, npm, Git and PostgreSQL 16+. Create a **new, empty, disposable** development database. Configure a local `DATABASE_URL` and `APP_URL=http://localhost:3000` in `.env`; copy from `.env.example` only if no `.env` already exists.
2. From the repository root run `npm ci`, then `npm run db:migrate`, then `npm run dev`. Open `http://localhost:3000`; `/api/health` must return `{ "ok": true }` without touching the database, and `/api/ready` must return `{ "ok": true }` after migrations.
3. Run `node scripts/check-setup.mjs local`. Warnings for unconfigured Stripe are expected until the billing guide is completed.
4. Run `npx next typegen`, `npm exec tsc -- --noEmit --pretty false`, `npx eslint src tests --max-warnings=0`, `npm run db:manifest:check`, `npm run db:check`, and `RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts`. The billing integration test intentionally refuses non-local database hosts. Run `npm run build` before shipping.

**Existing prototype databases:** earlier versions used `drizzle-kit push` and may already have tables without migration history. Do not run the initial `CREATE TABLE` migration blindly against them. For development, use a fresh empty database; for an existing environment, back it up and have a database operator compare the actual schema with the migration and design a reviewed baseline. Never delete or rewrite migration history just to make the command pass.

### First owner

Public registration always creates a free `user`. After creating the intended account, a trusted operator may promote that exact account through a privileged database session; audit the change and confirm exactly one row is returned. For example, inside `psql`, set a placeholder email with `\set owner_email 'owner@example.com'` and execute `UPDATE users SET role = 'owner' WHERE email = lower(:'owner_email') RETURNING id, email, role;`. Replace the example address in the secure session, not in committed code. Then use `/admin` to assign other roles. Do not create an unauthenticated owner-bootstrap endpoint.

### Local role seed scaffold (local-only, never staging or production)

For local development only, a guarded seed script creates nine accounts idempotently without touching `src/` (four role accounts plus five subscription-state fixtures for #9):

- `scripts/local/seed-users.ts` — inserts/updates `owner@solara.local`, `admin@solara.local`, `editor@solara.local`, `user@solara.local` and the billing fixtures `active-premium@solara.local`, `trialing-premium@solara.local`, `pastdue-premium@solara.local`, `expired-premium@solara.local`, `canceled-premium@solara.local` with a shared hashed password from `LOCAL_SEED_PASSWORD` (scrypt, same helper as `src/lib/passwords.ts`). Subscription rows are seeded with the correct `status`, `grantsAccess`, and `currentPeriodEnd` so `hasPremiumAccess` can be verified for every state (active/trialing grant, past_due/expired/canceled deny).
- Guard: requires `ALLOW_LOCAL_SEED=true` (must be `true` or `1`) and a non-empty `LOCAL_SEED_PASSWORD` (≥12 chars). The password is never committed; `.env.example` contains an empty placeholder.
- Safety: refuses any `DATABASE_URL` whose host is not `localhost`, `127.0.0.1`, `::1`, or `[::1]` (bracket-stripped so IPv6 loopback matches; host check is best-effort — an `ssh -L 5432:remote:5432` tunnel also appears as `127.0.0.1`). It also refuses when `CI`/`VERCEL`/`VERCEL_ENV` is set unless `ALLOW_LOCAL_SEED_IN_CI=true` is explicitly set for the disposable CI Postgres (127.0.0.1). Never set `ALLOW_LOCAL_SEED` in staging/production and never use production secrets locally; `ALLOW_LOCAL_SEED` + password is the real gate.
- Run: `ALLOW_LOCAL_SEED=true LOCAL_SEED_PASSWORD='a-strong-local-password-12+' DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_db npm run db:seed:local` — safe to re-run; email is the unique key. For CI disposable DB: `ALLOW_LOCAL_SEED_IN_CI=true ALLOW_LOCAL_SEED=true ... npm run db:seed:local`. Verify via `psql` or sign-in per role, and `tests/subscription-access.test.ts` covers the `hasPremiumAccess` matrix with `RUN_BILLING_INTEGRATION_TESTS=1`.
- Excluded from deploy: `.vercelignore` lists `scripts/local` (and `tests`, `drizzle/meta`) so Vercel never ships seed/mock code; `package.json` exposes `db:seed:local` as `tsx scripts/local/seed-users.ts`.

## Staging deployment

1. Create a separate managed PostgreSQL database and credentials; never copy production data. A managed provider such as Neon is suitable. Use its **pooled** TLS connection for application traffic and its **direct** connection for migrations. Verify transaction-mode pooling supports the app's transaction-level advisory locks.
2. Connect the repository to Vercel. Keep `main` as the production branch. Create a protected `staging` branch, assign a stable staging domain to that branch's **Preview** deployments, and scope Preview environment variables to `staging`. Ensure all other previews use isolated non-production resources or are disabled.
3. Set staging `DATABASE_URL` to the staging **pooled** URL and `APP_URL` to the staging HTTPS origin. Add only staging/test Stripe and map credentials per the feature guides. Configure `MAIL_TRANSPORT=resend|postmark`, `MAIL_FROM`, and the provider sandbox key; keep `CSP_MODE=report-only` for the first deployment. Variables used in the browser are built into the deployment, so redeploy after changing `NEXT_PUBLIC_*` values.
4. Before deploying code that needs a new schema, back up staging and run `npx tsx scripts/db-run.ts --env staging migrate` from an approved runner whose exported direct URL points to staging. Confirm the target out of band; do not print the URL. Then deploy the tested revision and run `node scripts/check-setup.mjs staging --strict` in a secure environment with staging values. `scripts/deploy.sh` runs a read-only hosted schema check against the reviewed ref before merge, then waits for Vercel's status on the merge SHA before checking `/api/ready`.
5. Verify `/api/health` (liveness), `/api/ready` (DB/schema/migrations/auth), registration/sign-in, chart creation, map search, both languages, PDF access control, test-mode checkout and webhook delivery. Protected Vercel domains require `VERCEL_AUTOMATION_BYPASS_SECRET` for readiness checks; a 401/403 is a hard failure, not a warning. If deployment protection blocks Stripe, arrange a narrowly scoped public webhook route or another supported bypass; the signed webhook must be reachable, while staging user pages should remain protected.

### Readiness failure modes

`/api/ready` is the deploy gate; `/api/health` only proves the process is alive. Use this table before retrying a failed deploy.

| Response | Meaning | First action |
|---|---|---|
| `db: "error"` or a timeout | Database unreachable, slow, TLS/pool failure | Check Neon and Vercel logs and pool saturation; do not blindly retry |
| `schema.missing` | Required table absent | Run the hosted read-only verify; apply the migration through `db-run`/`migrate.yml` |
| `schema.missingColumns` / `missingIndexes` | Partial or wrong migration | Stop; compare the journal and schema; add a forward migration |
| `migrations.pending` | Journal ahead of the database | Apply migrations before retrying |
| `migrations.unexpected` | Applied hash absent from the journal | Freeze, back up, compare branches; forward-fix or restore; never delete migration history |
| `auth: "degraded"` | Users table/permissions/RLS failure | Check the application role grants and RLS |
| `401` / `403` | Vercel Authentication blocked the probe | Set `VERCEL_AUTOMATION_BYPASS_SECRET` and retry |

Point uptime monitoring at `/api/ready` and keep `/api/health` for platform liveness.

Vercel notes that a new project may create an initial production deployment before its staging branch is configured. Set up environment isolation before using any real data. See [Vercel environments](https://vercel.com/docs/deployments/environments) and [Neon pooling](https://neon.com/docs/connect/connection-pooling).

## Production deployment

1. Before touching production, complete the launch gate in the [index](README.md). Create a distinct managed production database with TLS, least-privilege credentials, automated backups, point-in-time recovery where supported, and a tested restore. Use a pooled app connection and a direct migration connection.
2. Configure Vercel Production variables independently: production `DATABASE_URL`, canonical HTTPS `APP_URL`, live Stripe configuration, approved production geocoding/map settings, and a production email provider (`MAIL_TRANSPORT=resend|postmark`, `MAIL_FROM`, provider key). Keep `CSP_MODE=report-only` until the observation window is clean, then switch to `enforce`. Restrict access to secrets and do not pull production secrets to developer laptops.
3. Use short-lived feature branches → reviewed PR to protected `staging` → staging QA → reviewed promotion PR to protected `main`. Require CI checks and approvals; verify the promoted revision matches what was tested. Merging `main` deploys production through Vercel's production branch.
4. Generate future migrations on a feature branch with `npx drizzle-kit generate --name=add_feature`, review SQL and commit the migration **and** its metadata. Test on a fresh database and staging. Apply backward-compatible migrations from a controlled runner with `npx tsx scripts/db-run.ts --env production migrate` **before** deploying dependent code. Do not use `drizzle-kit push` on production.
5. Run the production configuration check in a secure runner, deploy, then verify `/api/health` and `/api/ready`, logs, error alerts, webhook delivery, login, access isolation and a controlled billing smoke test. If Vercel Authentication protects the domain, set `VERCEL_AUTOMATION_BYPASS_SECRET`; readiness must not be accepted as a warning. Record the release and rollback plan. Rolling back application code does not automatically reverse a migration; plan compatibility and restore procedures in advance (ADR 008).

## Operational checklist

- Keep staging and production domains, databases, Stripe modes, webhook secrets and map keys separate.
- Store secrets in the host/CI secret manager, restrict privileges, rotate credentials and redact logs. `APP_URL` must be the correct canonical HTTPS origin in each environment.
- Monitor errors, webhook retries, database connections, email delivery failures, auth rate-limit triggers, CSP reports and PDF execution time; define alert owners and incident procedures.
- Take and verify backups, practice restoring into an isolated database, and set recovery objectives before launch.
