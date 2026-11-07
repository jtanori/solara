# 1. Foundation, database and deployment

## What is implemented

Next.js App Router runs on Node.js with PostgreSQL through Drizzle. The app reads `DATABASE_URL`; `drizzle.config.ts` reads the same variable. The repository contains the initial migration in `drizzle/` and CI in `.github/workflows/ci.yml`. CI uses an isolated PostgreSQL service, applies migrations, checks types/lint, runs tests, audits production dependencies and builds.

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
2. From the repository root run `npm ci`, then `npx drizzle-kit migrate`, then `npm run dev`. Open `http://localhost:3000` and check `http://localhost:3000/api/health` returns `{ "ok": true }`.
3. Run `node scripts/check-setup.mjs local`. Warnings for unconfigured Stripe are expected until the billing guide is completed.
4. Run `npx next typegen`, `npm exec tsc -- --noEmit --pretty false`, `npx eslint src tests --max-warnings=0`, and `RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts`. The billing integration test intentionally refuses non-local database hosts. Run `npm run build` before shipping.

**Existing prototype databases:** earlier versions used `drizzle-kit push` and may already have tables without migration history. Do not run the initial `CREATE TABLE` migration blindly against them. For development, use a fresh empty database; for an existing environment, back it up and have a database operator compare the actual schema with the migration and design a reviewed baseline. Never delete or rewrite migration history just to make the command pass.

### First owner

Public registration always creates a free `user`. After creating the intended account, a trusted operator may promote that exact account through a privileged database session; audit the change and confirm exactly one row is returned. For example, inside `psql`, set a placeholder email with `\set owner_email 'owner@example.com'` and execute `UPDATE users SET role = 'owner' WHERE email = lower(:'owner_email') RETURNING id, email, role;`. Replace the example address in the secure session, not in committed code. Then use `/admin` to assign other roles. Do not create an unauthenticated owner-bootstrap endpoint.

### Local role seed scaffold (staging-only, never production)

For local development only, a guarded seed script creates four role accounts idempotently without touching `src/`:

- `scripts/local/seed-users.ts` — inserts/updates `owner@solara.local`, `admin@solara.local`, `editor@solara.local`, `user@solara.local` with a shared hashed password from `LOCAL_SEED_PASSWORD` (scrypt, same helper as `src/lib/passwords.ts`).
- Guard: requires `ALLOW_LOCAL_SEED=true` (must be `true` or `1`) and a non-empty `LOCAL_SEED_PASSWORD` (≥12 chars). The password is never committed; `.env.example` contains an empty placeholder.
- Safety: refuses any `DATABASE_URL` whose host is not `localhost`, `127.0.0.1`, or `::1`. Never set `ALLOW_LOCAL_SEED` in staging/production and never use production secrets locally.
- Run: `ALLOW_LOCAL_SEED=true LOCAL_SEED_PASSWORD='a-strong-local-password-12+' DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_db npm run db:seed:local` — safe to re-run; email is the unique key. Verify via `psql` or sign-in per role.
- Excluded from deploy: `.vercelignore` lists `scripts/local` (and `tests`, `drizzle/meta`) so Vercel never ships seed/mock code; `package.json` exposes `db:seed:local` as `tsx scripts/local/seed-users.ts`.

## Staging deployment

1. Create a separate managed PostgreSQL database and credentials; never copy production data. A managed provider such as Neon is suitable. Use its **pooled** TLS connection for application traffic and its **direct** connection for migrations. Verify transaction-mode pooling supports the app's transaction-level advisory locks.
2. Connect the repository to Vercel. Keep `main` as the production branch. Create a protected `staging` branch, assign a stable staging domain to that branch's **Preview** deployments, and scope Preview environment variables to `staging`. Ensure all other previews use isolated non-production resources or are disabled.
3. Set staging `DATABASE_URL` to the staging **pooled** URL and `APP_URL` to the staging HTTPS origin. Add only staging/test Stripe and map credentials per the feature guides. Variables used in the browser are built into the deployment, so redeploy after changing `NEXT_PUBLIC_*` values.
4. Before deploying code that needs a new schema, back up staging and run `npx drizzle-kit migrate` from an approved runner whose exported `DATABASE_URL` points to the staging **direct** database connection. Confirm the target out of band; do not print the URL. Then deploy the tested revision and run `node scripts/check-setup.mjs staging --strict` in a secure environment with staging values.
5. Verify `/api/health`, registration/sign-in, chart creation, map search, both languages, PDF access control, test-mode checkout and webhook delivery. If deployment protection blocks Stripe, arrange a narrowly scoped public webhook route or another supported bypass; the signed webhook must be reachable, while staging user pages should remain protected.

Vercel notes that a new project may create an initial production deployment before its staging branch is configured. Set up environment isolation before using any real data. See [Vercel environments](https://vercel.com/docs/deployments/environments) and [Neon pooling](https://neon.com/docs/connect/connection-pooling).

## Production deployment

1. Before touching production, complete the launch gate in the [index](README.md). Create a distinct managed production database with TLS, least-privilege credentials, automated backups, point-in-time recovery where supported, and a tested restore. Use a pooled app connection and a direct migration connection.
2. Configure Vercel Production variables independently: production `DATABASE_URL`, canonical HTTPS `APP_URL`, live Stripe configuration, and approved production geocoding/map settings. Restrict access to secrets and do not pull production secrets to developer laptops.
3. Use short-lived feature branches → reviewed PR to protected `staging` → staging QA → reviewed promotion PR to protected `main`. Require CI checks and approvals; verify the promoted revision matches what was tested. Merging `main` deploys production through Vercel's production branch.
4. Generate future migrations on a feature branch with `npx drizzle-kit generate --name=add_feature`, review SQL and commit the migration **and** its metadata. Test on a fresh database and staging. Apply backward-compatible migrations from a controlled runner using the direct production `DATABASE_URL` **before** deploying dependent code. Do not use `drizzle-kit push` on production.
5. Run the production configuration check in a secure runner, deploy, then verify health, logs, error alerts, webhook delivery, login, access isolation and a controlled billing smoke test. Record the release and rollback plan. Rolling back application code does not automatically reverse a migration; plan compatibility and restore procedures in advance.

## Operational checklist

- Keep staging and production domains, databases, Stripe modes, webhook secrets and map keys separate.
- Store secrets in the host/CI secret manager, restrict privileges, rotate credentials and redact logs. `APP_URL` must be the correct canonical HTTPS origin in each environment.
- Monitor errors, webhook retries, database connections and PDF execution time; define alert owners and incident procedures.
- Take and verify backups, practice restoring into an isolated database, and set recovery objectives before launch.
