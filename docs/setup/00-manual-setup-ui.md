# Manual Setup via UIs — #1 Branch Protection & #2 Vercel + Neon

This is the click-path for the two owner-only issues that cannot be automated with `GITHUB_TOKEN` (403). Do these in your browser, then verify with the `gh api` one-liners at the bottom.

---

## #1 — Branching `feature → staging → main` (GitHub UI)

**Context:** `main` is at `e779bec`, `staging` at `a4a914e` — content-identical but history diverged after the `--rebase` promotion. Both need protection + squash-only settings per [ADR 001](../decisions.md#adr-001--branching-model-feature--staging--main).

### A. Repository merge settings

**Link:** <https://github.com/jtanori/solara/settings> → scroll to **General** → **Pull Requests**

1. Check **Allow squash merging** → set **Default message:** *Pull request title and description* (or title only — pick one and keep).
2. **Check** *Allow merge commits* — needed for `staging → main` promotions (preserve ancestry, ADR 004).
3. **Uncheck** *Allow rebase merging*.
4. Check **Automatically delete head branches**.

> **Why squash + merge?** `feature → staging` is squash (one commit per feature, linear). `staging → main` is **merge commit** to keep `staging` an ancestor of `main` so future promotions diff only new work (see `docs/decisions.md` ADR 004 + PR #23). `scripts/deploy.sh` picks `--squash` vs `--merge` automatically.

*Verify locally:*
```bash
gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'
# expect {true,true,false,true}
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
  - ✓ *Require linear history* — keep on `staging` (feature PRs are squash)
  - ✓ *Block force pushes*
  - ✓ *Block deletions*
- **Save**

**Ruleset 2 — `main`:**
- Same as staging, but name `protect-main` and **uncheck Require linear history** (promotions are merge commits per ADR 004 — linear history would block `--merge`).
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
   - Copy **Direct** URL (no pooler) → this is `DATABASE_URL` for `db-run` migrations.
   - Confirm **Pooling mode = Transaction** for the pooled application URL. Lifecycle coordination uses a database lease row, not a session lock, so it is pooler-safe. Docs: <https://neon.com/docs/connect/connection-pooling>

> Never copy prod data to staging. Keep both `*_DIRECT` URLs out of Git — only paste into Vercel env vars or a secure shell for migrations.

### B. Vercel — connect repo + map branches

**Link:** <https://vercel.com/dashboard> → **Add New → Project** → Import `jtanori/solara`

If already imported:
1. **Settings → Git → Production Branch:** set to `main`.
2. **Settings → Domains:** (live: Production `www.thanatos.mx` → Production `main`; Staging `staging.thanatos.mx` → Git branch `staging` → Preview. The `*.vercel.app` domains remain as fallbacks.)
   - Add `www.thanatos.mx` → assign to **Production (`main`)** and make it the primary domain.
   - Add `thanatos.mx` → **Redirect** (308) to `www.thanatos.mx`. Sessions are host-only cookies, so serving both hosts would split sign-ins.
   - Add `staging.thanatos.mx` → Add → Git branch → `staging` → Preview. Docs: <https://vercel.com/docs/deployments/environments>
   - DNS records, TLS, Resend verification and the cutover order: [12-domains-and-email](12-domains-and-email.md).
3. **Settings → Environment Variables** → **Add** (pay attention to **Environment** + **Git Branch** scopes):

   | Variable | Value | Environment | Git Branch |
   |---|---|---|---|
   | `DATABASE_URL` | `<staging pooled>` | Preview | `staging` |
   | `APP_URL` | `https://staging.thanatos.mx` | Preview | `staging` |
   | `MAIL_TRANSPORT` | `resend` | Preview | `staging` |
   | `MAIL_FROM` | `Solara <no-reply@thanatos.mx>` | Preview | `staging` |
   | `MAIL_REPLY_TO` | `info@thanatos.mx` | Preview | `staging` |
   | `RESEND_API_KEY` (Sensitive) | `re_...` | Preview | `staging` |
   | `DATABASE_URL` | `<prod pooled>` | Production | `main` |
   | `APP_URL` | `https://www.thanatos.mx` | Production | `main` |
   | `MAIL_TRANSPORT` | `resend` | Production | `main` |
   | `MAIL_FROM` | `Solara <no-reply@thanatos.mx>` | Production | `main` |
   | `MAIL_REPLY_TO` | `info@thanatos.mx` | Production | `main` |
   | `RESEND_API_KEY` (Sensitive) | `re_...` | Production | `main` |
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
npx tsx scripts/db-run.ts --env staging migrate   # confirm target is staging, not prod
node scripts/check-setup.mjs staging --strict
```

Verify in staging domain: `GET /api/health` → `{"ok":true}` (liveness) and `GET /api/ready` → `{"ok":true}` (DB/schema/migrations/auth; use `VERCEL_AUTOMATION_BYPASS_SECRET` if deployment protection blocks it), sign-in, chart, map, both languages, PDF gate, test-mode Checkout + webhook (if Vercel protection blocks webhooks, add a narrow public `/api/billing/webhook` bypass — docs: <https://vercel.com/docs/security/deployment-protection>).

For **production** (before real customers): repeat with prod direct URL, but only after launch gate in `README.md`/`docs/decisions.md` ADR 003 is green.

### D. Runbooks to fill in (paste into `docs/setup/01-foundation-and-deployment.md` after you do it)

- Migration order: backup → migrate **direct** → deploy code.
- Backup/restore drill: Neon → Branches → Restore (test into isolated branch).
- Promotion: `feature → staging` (squash) → QA → `staging → main` (fast-forward/merge, not squash).
- Rollback: `vercel rollback` for code; DB rollback = forward migration, not automatic.
- Health/logs/alerts: Vercel → Deployments → Logs + Neon → Monitoring; define owner.

---

## Phase 0 — inventory for the Actions-owned pipeline (M5)

Fill this in **before** issue 6 (`deploy-staging.yml`) or issue 7 (`deploy-production.yml`) is
written. Record names, scopes and plans — never secret values. See
[`docs/plan-deployment-alignment.md`](../plan-deployment-alignment.md) §11–13.

### Vercel

| Item | Recorded value |
| --- | --- |
| Plan (Hobby / Pro) | |
| Production branch | |
| Deployment Protection enabled? | |
| Protection Bypass for Automation created? | |
| `git.deploymentEnabled` behaviour for feature-branch previews (spike S1) | |
| Preview env var scopes (which rows are `staging`-only vs all-preview vs all-environments) | |
| Preview routing verified: which database does a feature preview actually resolve to? (dashboard + a probe, not an inference) | |
| `ALLOW_PREVIEW_ON_STAGING` set? (only with verified read-only staging access; never production; never migrate) | |
| Preview guard decision **enforced** (isolated routing / verified read-only staging / quarantine with no hosted DB credential) | |
| Any `DATABASE_URL` row scoped to **both** Preview and Production? | |
| Runtime variable injection for a **promoted** candidate: mechanism and scope (production and staging) — prerequisite, not an S1 assumption | |

### Neon

| Item | Recorded value |
| --- | --- |
| Staging project / branch | |
| Staging endpoint ID (`ep-…`) | |
| Production project / branch (pooled + direct) | |
| Production endpoint ID (`ep-…`) | |
| Postgres major version (must match `ci.yml`) | |
| Read-only staging role created for the rehearsal gate and staging diagnostics? | |
| Read-only production role created for `production-diagnostics`? | |

### Vercel environment variables — scope audit

| Variable name | Preview | Production | Branch scope |
| --- | --- | --- | --- |
| `DATABASE_URL` | | | |
| `APP_URL` | | | |
| `NEXT_PUBLIC_*` (list) | | | |
| `STRIPE_*` (list) | | | |

> A `DATABASE_URL` visible to both Preview and Production is the failure mode the boot guard
> (issue 3) exists to make loud. If one already exists, fix the scope before Phase 3.
>
> **Build-time boundary (do not skip).** The build needs `DATABASE_URL` to *exist* but must not be
> able to connect. Record the build-only, non-routable placeholder mechanism (or the import
> refactor) and the proof that no hosted credential and no `vercel pull` env file is present in the
> build workspace or the uploaded artifact. See [guide 11](11-actions-deploys.md) §2.

### Spikes

- [ ] **S1** — does `deploymentEnabled: { "staging": false }` suppress feature-branch previews?
      Does `vercel deploy --prebuilt --env KEY=value` set runtime env or is it build-time only?
      Record the observed result and the date.
- [ ] **S2** — can a per-PR Neon branch receive its own runtime `DATABASE_URL` and be cleaned up on
      close? Record the mechanism, not a credential.

---

## Quick verification checklist (run locally after UI clicks)

```bash
gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'
gh api repos/jtanori/solara/rulesets --jq 'map({name,enforcement})'
vercel env ls   # or check dashboard env scoping
node scripts/check-setup.mjs local
```

Verify: `https://staging.thanatos.mx/api/health` and `https://www.thanatos.mx/api/health` should both return `{"ok":true}`; `/api/ready` must also return `{"ok":true}` (with `"migrations":"exact"`), using `VERCEL_AUTOMATION_BYPASS_SECRET` if protection is enabled.
