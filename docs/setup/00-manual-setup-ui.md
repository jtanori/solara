# Manual Setup via UIs — #1 Branch Protection & #2 Vercel + Neon

This is the click-path for the two owner-only issues that cannot be automated with `GITHUB_TOKEN` (403). Do these in your browser, then verify with the `gh api` one-liners at the bottom.

---

## #1 — Branching `feature → staging → main` (GitHub UI)

**Context:** `main` is at `e779bec`, `staging` at `a4a914e` — content-identical but history diverged after the `--rebase` promotion. Both need protection + squash-only settings per [ADR 001](../decisions.md#adr-001--branching-model-feature--staging--main).

### A. Repository merge settings

**Link:** <https://github.com/jtanori/solara/settings> → scroll to **General** → **Pull Requests**

1. Check **Allow squash merging** → set **Default message:** *Pull request title and description* (or title only — pick one and keep).
2. **Uncheck** *Allow merge commits*.
3. **Uncheck** *Allow rebase merging*.
4. Check **Automatically delete head branches**.

> **Why squash-only for `feature → staging`?** One commit per feature, linear history. **Exception:** `staging → main` promotions are **not** squashed — they are fast-forward/merge to keep `staging` an ancestor (see `docs/decisions.md` ADR 004 + PR #23 review).

*Verify locally:*
```bash
gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'
# expect {true,false,false,true}
```

### B. Branch protection rules (new Rulesets UI — recommended)

GitHub now prefers **Rulesets** over classic protection. Classic still works but `restrictions` (users/teams) is org-only and causes the `422` you saw.

**Link:** <https://github.com/jtanori/solara/settings/rules>

Click **New ruleset → New branch ruleset**:

**Ruleset 1 — `staging`:**
- **Name:** `protect-staging`
- **Enforcement status:** Active
- **Target branches:** Add target → *Include by pattern* → `staging`
- **Bypass list:** leave empty (no bypass)
- **Rules:** check:
  - ✓ *Require a pull request before merging*
    - Required approvals: **0** (single collaborator; bump to 1 when you add a second maintainer)
    - ✓ Dismiss stale pull request approvals when new commits are pushed
    - ✓ Require conversation resolution
  - ✓ *Require status checks to pass*
    - ✓ Require branches to be up to date before merging
    - Add check → search `verify` (the CI job: migrations → `next typegen` → `tsc` → `eslint` → `tsx --test` → `audit` → `build` + smoke 404s)
  - ✓ *Require linear history*
  - ✓ *Block force pushes*
  - ✓ *Block deletions*
- **Save**

**Ruleset 2 — `main`:**
- Same as staging, but name `protect-main`.
- Keep Required approvals **0** for now (author can't approve own PR anyway — GitHub blocks it; protection still requires `0` approvers). Documented in ADR 001 to bump to `1` later.

**Classic alternative (if Rulesets feels heavy):**
Link: <https://github.com/jtanori/solara/settings/branches> → *Add branch protection rule*
- Pattern `staging` (repeat for `main`)
- Check: Require pull request reviews before merging (Approvals **0**, ✓ Dismiss stale, ✓ Require conversation resolution)
- Check: Require status checks to pass (search `verify`, ✓ Require branches to be up to date)
- Check: Require linear history
- Check: Do not allow force pushes / deletions
- **Leave “Restrict who can push” unchecked** — that field is org-only and triggers the `Only organization repositories can have users and team restrictions` 422.

*Verify locally:*
```bash
gh api repos/jtanori/solara/rulesets --jq '.[].name'
# expect ["protect-staging","protect-main"] — not []
gh api repos/jtanori/solara/branches/staging/protection --jq '{required_status_checks, required_pull_request_reviews, allow_force_pushes}'
```

After this, a test PR `feature → staging → main` is already proven by #23/`#36`/`#38` — no need for a dummy PR.

---

## #2 — Staging & Production (Vercel + Neon UIs)

**Goals:** Separate DBs, pooled app URLs + direct migrate URLs, `main`→prod domain & `staging`→preview domain, per-env secrets, runbooks.

### A. Neon — create two isolated projects

**Link:** <https://console.neon.tech> → **New Project**

1. Create **solara-staging** (region `aws-us-east-1` or closest to Vercel). Do **not** import data.
2. Create **solara-prod** (same region, separate project).
3. For **each** project → **Dashboard → Connection Strings**:
   - Copy **Pooled** URL (contains `-pooler.` + `?sslmode=require`) → this is `DATABASE_URL` for the app.
   - Copy **Direct** URL (no pooler) → this is `DATABASE_URL` for `npx drizzle-kit migrate`.
   - Confirm **Pooling mode = Transaction** — required for `pg_advisory_xact_lock` used by Drizzle. Docs: <https://neon.com/docs/connect/connection-pooling>

> Never copy prod data to staging. Keep both `*_DIRECT` URLs out of Git — only paste into Vercel env vars or a secure shell for migrations.

### B. Vercel — connect repo + map branches

**Link:** <https://vercel.com/dashboard> → **Add New → Project** → Import `jtanori/solara`

If already imported:
1. **Settings → Git → Production Branch:** set to `main`.
2. **Settings → Domains:**
   - Add `solara.vercel.app` (or your custom prod domain) → assign to **Production (`main`)**.
   - Add `staging.solara.vercel.app` → Add → Git branch → `staging` → Preview. Docs: <https://vercel.com/docs/deployments/environments>
3. **Settings → Environment Variables** → **Add** (pay attention to **Environment** + **Git Branch** scopes):

   | Variable | Value | Environment | Git Branch |
   |---|---|---|---|
   | `DATABASE_URL` | `<staging pooled>` | Preview | `staging` |
   | `APP_URL` | `https://staging.solara.vercel.app` | Preview | `staging` |
   | `DATABASE_URL` | `<prod pooled>` | Production | `main` |
   | `APP_URL` | `https://solara.vercel.app` | Production | `main` |
   | `STRIPE_SECRET_KEY` (test) | `sk_test_...` | Preview | `staging` |
   | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (test) | `pk_test_...` | Preview | `staging` |
   | `STRIPE_WEBHOOK_SECRET` (test) | `whsec_...` | Preview | `staging` |
   | `STRIPE_SECRET_KEY` (live) | `sk_live_...` | Production | `main` |
   | `STRIPE_WEBHOOK_SECRET` (live) | `whsec_...` | Production | `main` |

   Add map keys similarly per `docs/setup/03-geocoding-and-maps.md`. Docs: <https://vercel.com/docs/projects/environment-variables>

   > Other PR Previews (feature branches) should either use isolated non-prod resources or be disabled (Settings → Git → Ignored Build Step) to avoid leaking prod data.

4. **Deploy:** Push to `staging` → Vercel builds Preview. Push to `main` → Production.

### C. First migration + smoke (secure shell)

**Do not print the direct URL** — export it, run, clear history if needed.

For **staging**:
```bash
export DATABASE_URL="<STAGING_DIRECT_URL>"
npx drizzle-kit migrate   # confirm target is staging-pooler host, not prod
node scripts/check-setup.mjs staging --strict
```

Verify in staging domain: `GET /api/health` → `{"ok":true}`, sign-in, chart, map, both languages, PDF gate, test-mode Checkout + webhook (if Vercel protection blocks webhooks, add a narrow public `/api/billing/webhook` bypass — docs: <https://vercel.com/docs/security/deployment-protection>).

For **production** (before real customers): repeat with prod direct URL, but only after launch gate in `README.md`/`docs/decisions.md` ADR 003 is green.

### D. Runbooks to fill in (paste into `docs/setup/01-foundation-and-deployment.md` after you do it)

- Migration order: backup → migrate **direct** → deploy code.
- Backup/restore drill: Neon → Branches → Restore (test into isolated branch).
- Promotion: `feature → staging` (squash) → QA → `staging → main` (fast-forward/merge, not squash).
- Rollback: `vercel rollback` for code; DB rollback = forward migration, not automatic.
- Health/logs/alerts: Vercel → Deployments → Logs + Neon → Monitoring; define owner.

---

## Quick verification checklist (run locally after UI clicks)

```bash
gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'
gh api repos/jtanori/solara/rulesets --jq 'map({name,enforcement})'
vercel env ls   # or check dashboard env scoping
node scripts/check-setup.mjs local
```

Tell me “#1 and #2 done” and I’ll immediately open **#3 `AGENTS.md`** (depends on these) from `arena/75fa5f0e-solara` targeting `staging`.
