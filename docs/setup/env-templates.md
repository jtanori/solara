# Env templates — `.env.staging` / `.env.production`

Two ready-to-copy templates are in the repo root (gitignored):

- `.env.staging.example` → copy to `.env.staging`
- `.env.production.example` → copy to `.env.production`

```bash
cp .env.staging.example .env.staging      # edit with your Neon pooled URL + staging APP_URL + Stripe test keys
cp .env.production.example .env.production # edit with prod pooler + prod APP_URL + Stripe live keys

# verify before uploading (format-only, never prints values)
node scripts/check-setup.mjs staging --strict   # with .env.staging exported or DATABASE_URL/APP_URL in shell
node scripts/check-setup.mjs production --strict
```

**Vercel upload:**

- **Via CLI:**
  ```bash
  vercel link --project solara
  # for staging (Preview, branch staging)
  vercel env pull .env.staging --environment preview --git-branch staging  # or:
  # open each var → vercel env add DATABASE_URL preview (paste pooled URL, scope to staging)
  # for production
  vercel env add DATABASE_URL production  # paste prod pooler, scope to main
  vercel env add APP_URL production
  ```

- **Via UI (recommended for first setup):** <https://vercel.com/dashboard> → Project → Settings → Environment Variables → Add → pick **Preview** (branch `staging`) for staging vars, **Production** for prod vars. Paste the values from your local `.env.staging` / `.env.production`.

**Important:**

- `DATABASE_URL` in Vercel is always the **pooled** Neon URL (`-pooler.` + `?sslmode=require`). Keep the **direct** (non-pooler) URL only in your secure migration shell, never in Vercel.
- `NEXT_PUBLIC_*` vars are baked into the build — redeploy after changing them.
- Never set `ALLOW_LOCAL_SEED*` or `LOCAL_SEED_PASSWORD` in Vercel — the app refuses them when `VERCEL` is set.


## Two ways to migrate — pick by where the credential lives

The database URL is held in **GitHub Environment secrets** (`staging`, `production`), so the default
is to migrate from CI. A secret can never be read back to a laptop (GitHub only allows writing), so
"use the Environment secret locally" is not possible by design — the workflow has to be the one that
connects.

| | credential | use when |
|---|---|---|
| **CI (default)** — `npm run db:migrate:remote -- --pr <n>` | GitHub Environment secret | always; this is what `scripts/deploy.sh` triggers before a merge |
| **Local** — `npx tsx scripts/db-run.ts --env <e> migrate` | `.env.<env>` on your machine | break-glass, or before the Environment secrets exist |

### CI path (`scripts/db-remote.ts`)

```bash
npm run db:check -- --env staging          # read-only: dispatch migrate.yml in verify mode
npm run db:migrate:remote -- --pr 97       # migrate the DB for PR 97, wait, report the verdict
npm run db:migrate:remote -- --pr 97 --dry-run   # print the plan + exact dispatch payload
npm run db:migrate:remote -- --pr 98 --env production --rehearsal-pr 97
```

**Production is gated in the workflow, not by a reviewer** — this is a solo repository, so
required reviewers would be self-approval. A production dispatch needs `--rehearsal-pr` (the
PR already migrated on staging), a full commit SHA, and a green `migrate staging pr-<n>` run
for that PR. See `docs/operations/production-migration-gate.md`.

It resolves the PR's head SHA, refuses an `--env` that contradicts the PR's base branch (a staging
PR can never migrate production), dispatches `.github/workflows/migrate.yml` against that SHA, finds
that exact run by `run-name`, waits for it and exits non-zero unless it succeeded. Add `--json` for
machine output, `--skip-wait` to dispatch and return the run URL.

`deploy.sh` does the same dispatch inline before merging; `db-remote.ts` is the standalone,
inspectable version used when you want to run the migration as its own step.

### Local path (`scripts/db-run.ts`)

`drizzle.config.ts` reads only `DATABASE_URL`, so the migration target used to depend on whichever
URL happened to be exported. Use the runner instead — it takes the environment explicitly, resolves
`DATABASE_URL_DIRECT` from that environment's file, prints only `user@host/database`, and refuses to
run when the target looks wrong (pooled host, loopback for a hosted env, unset/loose `sslmode`).

```bash
# inspect (no DDL, connects read-only)
npm run db:status -- staging
npm run db:status -- production

# apply (staging), then verify
npx tsx scripts/db-run.ts --env staging migrate
npm run db:verify -- staging

# production requires typed confirmation
npx tsx scripts/db-run.ts --env production migrate         # prompts: type "production"
npx tsx scripts/db-run.ts --env production migrate --yes   # only for CI/runners
```

Guards, all verified:

| Situation | Behaviour |
|---|---|
| no `--env` | refuses: "there is no default: this tool will not guess a database" |
| `--env prod` (typo) | refuses, lists the valid values |
| `DATABASE_URL_DIRECT` contains `-pooler.` | refuses before connecting — migrations need the direct host |
| hosted env pointing at loopback (or `local` pointing at a host) | refuses |
| `sslmode` unset / `require` / `prefer` | warns (use `verify-full`; `require` changes meaning in pg 9) |
| production migrate without `--yes` | requires typing `production` |
| after migrating | re-reads the journal and fails if anything is still pending |

The runner delegates the actual DDL to `npx drizzle-kit migrate` with `DATABASE_URL` set to the
resolved direct URL for that environment only, so it stays compatible with `drizzle/meta` and the
`drizzle.__drizzle_migrations` hash format.
