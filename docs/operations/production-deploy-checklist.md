# Production deploy checklist — 2026-11-10

Run top to bottom. Each step has a command and an expected result. Stop at the first surprise.

---

## Fill these four blanks first

| Blank | Where to get it |
|---|---|
| `YOUR_DOMAIN` | The domain you will send mail from, **already verified in Resend** |
| `RE_STAGING_KEY` | Resend → API Keys → create, permission **Sending** (`re_…`) |
| `RE_PRODUCTION_KEY` | Resend → API Keys → create a **second** key, permission **Sending** |
| `BYPASS_SECRET` | Vercel → Project `solara` → Settings → Deployment Protection → Protection Bypass for Automation |

If `YOUR_DOMAIN` is not verified in Resend yet, stop here and verify it. Nothing else works without it.

---

## Step 1 — Configure mail in **staging first** (proves Resend before production)

Staging (`solara-stg`) currently has **no** `MAIL_*` variables either, and `resolveMailTransportName()`
throws in production builds. So today a sign-up on staging succeeds but the verification email can
never be sent — and since `auth.ts` requires `emailVerifiedAt` to hold a session, **nobody can log in
on staging**. Configure it here first: it is the cheapest possible test of your Resend domain.

Vercel dashboard → project `solara` → Settings → Environment Variables. Add these **three**, each with
Environment = **Preview** and, under Preview, select branch **`staging`** only:

```
MAIL_TRANSPORT = resend
MAIL_FROM      = Solara Staging <no-reply@YOUR_DOMAIN>
RESEND_API_KEY = RE_STAGING_KEY
```

Why branch-scoped: Vercel's `Preview` target alone applies to **every** preview deployment, including
the ~15 Dependabot PR previews. Branch-scoping keeps the key off those builds.

Then redeploy staging so the vars are baked. `staging` is protected (no direct pushes), so this goes
through a PR like any other change:

```bash
git fetch origin staging
git switch -c chore/redeploy-staging-mail origin/staging
git commit --allow-empty -m "chore: redeploy staging for mail configuration"
git push origin chore/redeploy-staging-mail
gh pr create --base staging --head chore/redeploy-staging-mail \
  --title "chore: redeploy staging for mail configuration" \
  --body "Empty commit to rebuild the staging preview after adding MAIL_* env vars."
gh pr merge <that-pr-number> --squash
```

Expected: `verify` green, merge succeeds, staging deployment rebuilds and succeeds.

---

## Step 1B — Prove mail works on staging

At `https://solara-stg.vercel.app`:

1. **Sign up** with an address you can read.
2. **Check the inbox.** Mail must arrive and come *from* `YOUR_DOMAIN`.
3. **Click verify**, then **sign in**.

Expected: all three pass. If step 2 fails, fix the Resend domain/key **here** — do not proceed. This is
the same failure that would otherwise appear in production after the migration.

Note: if a test gets into a strange state (for example a token already used), just use a different
address rather than auditing tokens by hand.

---

## Step 1C — Set the same three vars for production

Same dashboard, add the same three keys again, Environment = **Production**, type = **Sensitive**:

```
MAIL_TRANSPORT = resend
MAIL_FROM      = Solara <no-reply@YOUR_DOMAIN>
RESEND_API_KEY = RE_PRODUCTION_KEY
```

Use a **separate API key** from staging, so staging traffic cannot affect production sending
reputation and you can revoke one without the other.

Expected: 3 rows listed with target `Production`.

---

## Step 2 — Back-merge `main` into `staging`

```bash
git fetch origin main staging
git switch -c chore/promote-sync-main origin/staging
git merge --no-ff origin/main -m "chore: back-merge main into staging (promotion prerequisite)"
git push origin chore/promote-sync-main
gh pr create --base staging --head chore/promote-sync-main \
  --title "chore: back-merge main into staging (promotion prerequisite)" \
  --body "Brings main's commits into staging so deploy.sh's base-freshness gate can pass the promotion. Zero file changes; requires a merge commit (see Step 2 note)."
```

Expected: `verify` green, then merge it:

```bash
gh pr merge <that-pr-number> --merge
```

If the ruleset blocks a merge commit on `staging`, **do not fall back to squash**: a squash keeps the
content and drops the SHAs, so `main` is still not an ancestor, the promotion PR stays `BEHIND`, and
`deploy.sh`'s base-freshness gate refuses it. There is no override. The one supported route is to
lift `required_linear_history`, merge the back-merge with `--merge`, and restore the rule — see
`production-bootstrap-2026-11-10.md` §4.1a.

Confirm afterwards, before opening the promotion PR:

```bash
git fetch origin main staging
git merge-base --is-ancestor origin/main origin/staging && echo "ancestry: literal"
git log --oneline --cherry-pick --left-only origin/main...origin/staging   # must print nothing
```

---

## Step 3 — Open the promotion PR

```bash
gh pr create --base main --head staging \
  --title "chore: promote staging to main (2026-11-10)" \
  --body-file docs/promotion-pr-body.md
```

Expected: PR opened. **Do not push to it again** — Step 4 freezes its SHA.

---

## Step 4 — Freeze the SHA and rehearse on staging

```bash
PROMO_PR=<promotion-pr-number>
PROMO_REF=$(gh pr view $PROMO_PR --json headRefName --jq .headRefName)
PROMO_SHA=$(gh pr view $PROMO_PR --json headRefOid --jq .headRefOid)
echo "$PROMO_REF@$PROMO_SHA"

gh workflow run migrate.yml --ref "$PROMO_REF" \
  -f env=staging -f pr="$PROMO_PR" -f sha="$PROMO_SHA" \
  -f mode=migrate -f dry_run=false
```

Then:

```bash
gh run list --workflow=migrate.yml --limit 3
```

Expected run name, exactly:

```
migrate staging pr-<PROMO_PR> <PROMO_SHA> mode=migrate dry=false
```

Expected conclusion: `success`. Record `PROMO_SHA` — Steps 5 and 6 reuse it.

---

## Step 5 — Migrate production (first run ever: creates the whole schema)

Take a Neon snapshot of `solara-prod` first (Neon dashboard → Branches → `solara-prod` → Create branch). Do not skip.

```bash
npx tsx scripts/db-remote.ts --pr "$PROMO_PR" --env production --rehearsal-pr "$PROMO_PR"
```

Expected: `success`, and the log reports tables created (not "nothing to do"). The run hard-fails if the Step 4 rehearsal is missing or the SHA does not match.

---

## Step 6 — Verify production schema

```bash
npx tsx scripts/db-remote.ts --check --env production --branch "$PROMO_REF" --sha "$PROMO_SHA"
```

Expected, exactly:

```
OK production schema and drizzle journal are in sync
```

If not, stop. Do not deploy.

---

## Step 7 — Deploy

```bash
export VERCEL_AUTOMATION_BYPASS_SECRET=BYPASS_SECRET
./scripts/deploy.sh --pr "$PROMO_PR" --env production
```

**Do not add `--skip-migrate`.** Step 5 already ran the DDL and the migrate workflow is idempotent, so
running it again is a no-op; `--skip-migrate` on a promotion whose diff changes `drizzle/` is refused
by `decide_skip_migrate` (`refuse-production`) and the script exits before merging. The command above
is the supported path.

Expected: merge completes, Vercel builds, `/api/ready -> {"ok":true}`, script exits 0.

---

## Step 8 — Prove it works (5 checks, ~5 minutes)

```bash
curl -fsS -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  https://solara-production.vercel.app/api/ready
```
→ `{"ok":true}`

Then in a browser at `https://solara-production.vercel.app`:

1. **Sign up** with a real address you can read.
2. **Check the inbox.** Email must arrive and come *from* `YOUR_DOMAIN`. This is the step that proves Resend.
3. **Click verify**, then **sign in**.
4. **Password reset** round trip.
5. Re-run the `curl` above. → still `{"ok":true}` (proves it passes with a real user row, not just empty tables).

---

## If something fails

| Symptom | Cause | Action |
|---|---|---|
| `curl` returns 401/403 | bypass secret missing or wrong | fix `VERCEL_AUTOMATION_BYPASS_SECRET` |
| Sign-up returns 500, log has `42P01` | migrate did not run | re-run Step 5 |
| Sign-up works but no email arrives | `YOUR_DOMAIN` not verified in Resend, or `MAIL_FROM` uses a different domain | fix in Resend, update `MAIL_FROM`, redeploy |
| Staging: sign-in fails right after sign-up | staging mail vars missing or not baked into the deployment | redo Step 1 + redeploy staging |
| Sign-in fails right after verifying | `RESEND_API_KEY` not `re_`-prefixed | recheck Step 1 |
| `deploy.sh` says `refusing to deploy a stale PR` | Step 2 not merged | merge it, re-run Step 3–4 with the new SHA |
| `deploy.sh` says `not CLEAN` | CI red on the promotion PR | fix on `staging`, new SHA, redo Step 4 |
| `/api/ready` not ok after deploy | schema or DB issue | run Step 6 again, then read the response body |

## Rollback

Code: Vercel → Deployments → previous `main` deployment → **Promote to Production**.
Schema: forward fix (new migration) or Neon point-in-time restore. There is no down migration.

## Known-missing after this deploy (not failures)

- No scheduled jobs: `rate_limits` / `email_tokens` tables grow unbounded.
- No error tracking: failures surface only when someone reports them.
- Readings stay off (`READINGS_*` unset). No LLM traffic.
- CSP is report-only.
