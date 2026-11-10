# Pull request

## Summary
<!-- What does this PR change and why? Link the issue. -->

## Linked issue
Closes #<!-- issue number --> — <!-- title -->

## Branching and merge policy
- [ ] This PR targets `staging` (feature → staging → main). Direct PRs to `main` are only for promoting `staging`.
- [ ] Branch name follows `<type>/<issue-number>-<slug>` (e.g. `feat/13-usage-guide-role-scope`).
- [ ] Merge method: **squash for `feature→staging`, merge commit for `staging→main`** (repo Settings → General → Pull Requests: `allow_squash_merge:true`, `allow_merge_commit:true`, `allow_rebase_merge:false`, `delete_branch_on_merge:true`; verify via `gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'` → `{true,true,false,true}`).
- [ ] Branch protection (applied `protect-staging`/`protect-main`) requires PR, `verify` status check, conversation resolution, and blocking force-push/deletion; `staging` requires linear history, `main` allows merge commits for promotions. See `docs/decisions.md` ADR 001 and ADR 004.

## Evidence
- [ ] `npm ci` + `npx drizzle-kit migrate` (CI does this on a disposable DB)
- [ ] `npx next typegen`
- [ ] `npm exec tsc -- --noEmit --pretty false`
- [ ] `npx eslint src tests --max-warnings=0`
- [ ] `RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts`
- [ ] `npm run build` succeeds
- [ ] `npm run db:manifest:check` and `npm run db:check` pass
- [ ] Smoke checks (CI `verify` job): `GET /api/health` and `GET /api/ready` return 200; `GET /blueprint` → 404, `GET /setup` → 404, `GET /usage-guide` → 404 outside development, and no internal-doc content leaked (`EL PROYECTO DE SOLARA` absent). For internal-doc link gating also verify homepage/dashboard/footer contain no `/blueprint`, `/setup`, `/usage-guide` links outside development.
- [ ] Security smoke: HTML carries `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and the CSP header; mutating `/api/*` without `Origin`/`Sec-Fetch-Site` → 403; same-origin request passes.
- Paste local command output or CI run link:

## Test plan
<!-- How was this tested? What was manual QA? Which locales/browsers? -->
- [ ] Existing tests pass
- [ ] Added/updated tests for new behavior (if applicable)
- [ ] Manual QA in `development` and `production` (`NODE_ENV`) modes — note which routes and roles were checked

## Risk
<!-- What could break? Is it backward-compatible? Feature-flagged? -->
- Risk level: <!-- low / medium / high -->
- Mitigations:

## Rollout / Rollback
- Rollout: merge to `staging` → QA on staging → promotion PR `staging → main` → Vercel production deploy. Secrets are per-environment (never use prod secrets locally; previews do not access prod data).
- Rollback: revert squash commit on `staging`/`main` or promote previous `staging` commit; rolling back code does **not** automatically reverse a migration — plan compatibility and restore per ADR 008 and `docs/setup/01-foundation-and-deployment.md`.
- Operational runbook updated: <!-- yes / no / N/A -->

## Checklist
- [ ] No secrets committed (`.env` never committed; `.env.example` contains placeholders only)
- [ ] Docs updated (`README.md`, `docs/setup/*`, `docs/decisions.md`, `BACKLOG.md` when issues change) and `BACKLOG.md` links resolve
- [ ] No mocked/seed code in `src/` (keep in `scripts/`)
- [ ] **Accepted for promotion** — maintainer posted deploy command as a comment:
  - feature PR → `staging`: `./scripts/deploy.sh --pr <number> --env staging`
  - promotion PR `staging → main`: `./scripts/deploy.sh --pr <number> --env production` (runs `migrate.yml` for `production` env **before** merge if `drizzle/` touched, then `--merge` to preserve ancestry).

<!--
Accepted-for-promotion comment copy — paste the one matching the target branch:

— Feature → staging (PR targets `staging`) —
✅ **Accepted for promotion — ready to deploy to staging**

CI is green (`verify` 1m30s + Vercel Preview → `solara-stg.vercel.app`). Check `[x]` below then deploy — if drizzle/ changed, `deploy.sh` will trigger `.github/workflows/migrate.yml` for Environment `staging` (secret `DATABASE_URL` = Neon direct, no -pooler) *before* merging.

- [ ] touches `drizzle/` — will dispatch `migrate.yml` (Env: staging)
- [ ] does not touch `drizzle/` — direct merge

Run locally (no local DB URL needed):
```bash
./scripts/deploy.sh --pr <number> --env staging
```
See `scripts/deploy.sh --help` and `docs/setup/00-manual-setup-ui.md`. After merge, verify `curl https://solara-stg.vercel.app/api/health` → `{"ok":true}` and `/api/ready` → `{"ok":true}` (use `VERCEL_AUTOMATION_BYPASS_SECRET` for protected domains).

— Promotion staging → main (PR targets `main`) —
✅ **Accepted for promotion — ready to deploy to production**

Staging QA done on `https://solara-stg.vercel.app` + `verify` on `staging` is green. This promotion uses `merge commit` (not squash) to keep `staging` ancestor of `main` per ADR 004. If `drizzle/` changed, `deploy.sh` will trigger `migrate.yml` for Environment `production` (secret `DATABASE_URL` = Neon direct) *before* merging to avoid Vercel/migration race.

- [ ] touches `drizzle/` — will dispatch `migrate.yml` (Env: production)
- [ ] does not touch `drizzle/` — direct merge

Run locally (no local DB URL needed):
```bash
./scripts/deploy.sh --pr <number> --env production
```
Requires repo `Allow merge commits:true` (Settings → General → Pull Requests) and `protect-main` without linear history. Ensure GitHub Environment `production` has required reviewers + branch restriction to `main` (Settings → Environments → production).
-->

---
Target branch for this PR is `staging`. Deploy via `scripts/deploy.sh` (see `docs/setup/00-manual-setup-ui.md`); `main` deploys production via Vercel — see ADR 001/ADR 004.
