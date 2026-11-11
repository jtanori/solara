# Production bootstrap — decisions locked and the path to deploy

> **Note (2026-11-10):** `BACKLOG.md` was removed from the repository in favour of an on-demand,
> gitignored snapshot — see **ADR 009** and #132. References to it below describe the state at the
> time of writing.

Follows `production-readiness-audit-2026-11-10.md`. Records the operator's answers of 2026-11-10 and
turns them into an executable sequence. Supersedes the "HAZARD A" risk framing for *this* deploy.

---

## 1. Decisions on record

| Question | Answer | Consequence |
|---|---|---|
| Mail provider | **Resend** | `MAIL_TRANSPORT=resend` + `MAIL_FROM` + `RESEND_API_KEY` (`re_…`) |
| Production accounts | **None. Everything is new.** | This is a **bootstrap**, not a migration — see §2 |
| Can run `deploy.sh` with Vercel access | **Yes** | Path A from the audit is available; no manual-merge fallback needed |

---

## 2. "Everything is new" changes the migration from risky to boring

The audit's HAZARD A was that `0002_email_verification` deletes every session for every
pre-existing user, and that migrated-then-unverified accounts cannot hold a session. With an **empty
production database**, every one of those statements is a **no-op**:

- `DELETE FROM "sessions" WHERE user_id IN (… email_verified_at IS NULL)` → 0 rows, because there are
  no sessions and no users.
- `DELETE FROM "email_tokens" WHERE used_at IS NULL` → 0 rows.
- No `email_verified_at` backfill is needed, and no existing user can be locked out.

So the first production migrate is **pure DDL against an empty database**. That removes the "data
decision" from the checklist entirely. What does **not** disappear is the requirement that Resend
works before the first user signs up, because verification is now mandatory for every account:

- `0002` adds `users.email_verified_at`, and `src/lib/auth.ts` requires
  `isNotNull(users.emailVerifiedAt)` to hold a session. A brand-new user who cannot receive the
  verification email is a user who cannot log in — the failure moved from "existing users" to
  "every user, on day one".

That makes §3 a **blocking prerequisite**, not a nice-to-have.

### New expectations for a fresh bootstrap (so a later audit does not false-alarm)

- The database should contain **7 application tables + `drizzle.__drizzle_migrations`** after the
  migrate. `0000` creates the 7 base tables; `0001`–`0003` add `rate_limits`, `email_tokens`,
  `generation_cache`, `reading_documents`.
- `sessions`, `users`, `readings`, `subscription*`, `knowledge`, `audit_logs` will all be **empty**.
  That is correct, not a failure.
- The bootstrap is **not** a migration rehearsal: the staging rehearsal in the gate proves the
  *journal* applies cleanly, while production additionally runs `0000` against nothing. Both are
  expected to succeed; they exercise different starting states.

---

## 3. Blocking prerequisite: turn on Resend in production

Target configuration (names only — never write the key into a file, a commit, or this repo):

```
MAIL_TRANSPORT=resend
MAIL_FROM=Solara <no-reply@your-domain.example>   # must be a verified Resend domain
RESEND_API_KEY=re_…                                # from the Resend dashboard, Send permission
# MAIL_REPLY_TO is optional
```

### Two things that are easy to get wrong

1. **`MAIL_FROM` must use a domain verified in Resend.** `onboarding@resend.dev` only delivers to
   the Resend account owner's own address. If the sending domain is not verified, verification
   emails are rejected by Resend and users cannot activate. This is the single most likely reason the
   first sign-up fails after an otherwise perfect deploy.
2. **`RESEND_API_KEY` must start with `re_`.** `scripts/check-setup.mjs` rejects any other prefix, and
   `createMailTransport` fails closed on a missing key.

### Set them in the production Vercel environment

Generate the automation secret on the Vercel side and the API key in the Resend dashboard. Then:

```bash
# Values are piped, never passed as arguments, so they do not land in shell history.
printf '%s' 'resend' | vercel env add MAIL_TRANSPORT production --sensitive --force
printf '%s' 'Solara <no-reply@YOUR-VERIFIED-DOMAIN>' | vercel env add MAIL_FROM production --sensitive --force
printf '%s' 're_YOUR_KEY' | vercel env add RESEND_API_KEY production --sensitive --force
```

`sensitive` values are only visible to deployments created *after* they are set, so this must happen
**before** the promotion merge — the promotion build is what bakes them.

### Verify, do not assume

`scripts/check-setup.mjs` correctly flags the gap today:

```
$ node scripts/check-setup.mjs production --strict
ERROR DATABASE_URL is missing or is not a valid PostgreSQL URL.
ERROR APP_URL is missing; …
ERROR Stripe is incomplete: …
ERROR MAIL_TRANSPORT is required for hosted environments (resend or postmark).
$ echo $?   # 1
```

(Correction to an earlier note of mine: the script **does** exit non-zero — `--strict` turns warnings
into errors and `process.exitCode = 1`. I had misread `head`'s status, not the script's.)

**But read what it checks.** It validates the environment visible to the *shell*: with no
`.env.production` it sees an empty process environment, which is why everything reports missing. It
does **not** read Vercel's environment variables. So to use it meaningfully against production you
must export the values from Vercel first (or run the check inside a deployment). Presence of a
key in the Vercel env list is **not** proof of validity — only a real send proves Resend works.

**Cheapest real send test**, after the deploy: request a verification email for an address you
control, and confirm it arrives *from* the verified domain. Do this before inviting anyone.

---

## 4. The sequence (Path A — `deploy.sh`, per `production-migration-gate.md`)

Steps 3 and 4 are **[HUMAN]** and must run from a shell with Vercel access; nothing here can be
executed by an agent, and the production `DATABASE_URL` is correctly Environment-scoped.

### 4.1 Back-merge `main → staging` (restores ancestry so the freshness gate passes)

```bash
git fetch origin main staging
git switch -c chore/promote-sync-main origin/staging
git merge --no-ff origin/main -m "chore: back-merge main into staging (promotion prerequisite)"
git push origin chore/promote-sync-main
gh pr create --base staging --head chore/promote-sync-main \
  --title "chore: back-merge main into staging (promotion prerequisite)" \
  --body "main is not an ancestor of staging, so deploy.sh's base-freshness gate refuses the promotion. Zero file changes: \`git diff origin/staging...origin/main\` is empty and the trial-merge tree is identical to origin/staging^{tree}. Prerequisite for the staging → main promotion."
```

Merge it with `--merge` once `verify` is green.

> **A squash here does NOT restore ancestry.** `protect-staging` requires linear history, so the
> ruleset may reject the merge commit — and if you fall back to squash, the original `main` SHAs
> never become ancestors of `staging`, which is exactly what `deploy.sh`'s ancestry gate checks.
> The content matches; the SHAs do not. See §4.1a.

#### 4.1a If the merge commit is refused

`protect-staging` requires **linear history**, so a merge commit into `staging` may be rejected. The
obvious fallback — squash — does **not** restore ancestry: the content lands, the `main` SHAs do not,
and `git merge-base --is-ancestor main staging` still fails. Nothing short of a merge commit into
`staging` can make `main`'s commits ancestors of `staging`, and the ruleset forbids exactly that.

So do not pretend the squash satisfies the gate. Two supported paths:

**Path A — lift linear history for this one back-merge (records true ancestry).**
Temporarily disable `required_linear_history` on the `protect-staging` ruleset, merge the back-merge
PR with `--merge`, then restore the rule. This is the only path that makes the ancestry check pass on
its own terms. Record in the promotion PR that the rule was lifted, and why.

**Path B — promote with a content-equivalent history (no ruleset change).**
Squash-merge the back-merge, then promote. `deploy.sh` does not refuse this: it distinguishes "main's
content is missing from staging" (refused) from "main's content is present under different SHAs"
(allowed, with a warning). That distinction is `decide_promotion_readiness`, and it is what keeps a
genuinely stale branch from slipping through.

Verify either way before promoting:

```bash
git fetch origin main staging
# 0 = literal ancestry (Path A). Non-zero is fine for Path B as long as the content check is empty:
git merge-base --is-ancestor origin/main origin/staging && echo "ancestry: literal"
git log --oneline --cherry-pick --left-only origin/main...origin/staging   # must print nothing
```

An empty last command means every `main` commit's change is already on `staging`. Anything printed is
real work `staging` does not have — back-merge that content before promoting, not just its ancestry.

### 4.2 Open the promotion PR

Body: `docs/promotion-pr-body.md`, amended for these decisions:

- production is **empty**, so the `0002` session-wipe section becomes a one-line "no-op: no data".
- mail provider is **Resend**.
- **do not** use the `UPDATE users SET email_verified_at = now()` mitigation — there are no users.

### 4.3 Freeze the SHA, then rehearse on staging

Run `production-migration-gate.md` §"The procedure" steps 1–4 verbatim. It freezes the head SHA,
asserts the workflow markers, re-checks the head did not move, and dispatches
`migrate staging pr-<n> <SHA> mode=migrate dry=false`. Confirm the run name and that
`migration-applied.json` is in the verdict artifact. The last such rehearsal on record is
`pr-127 @ e9d0abd` — a fresh one for this SHA is mandatory.

### 4.4 Migrate production (first-ever run: creates the whole schema)

```bash
npx tsx scripts/db-remote.ts --pr "$PROMO_PR" --env production --rehearsal-pr "$PROMO_PR"
```

Gate clauses 1–6 fail closed. Read the output as "7 tables + 4 indexes created", not "3 migrations
applied". **Take a Neon snapshot of `solara-prod` first** — ADR 008: no down migrations, recovery is
a forward fix or a point-in-time restore.

### 4.5 Verify the schema, then deploy

```bash
# must print: OK production schema and drizzle journal are in sync
npx tsx scripts/db-remote.ts --check --env production --branch "$PROMO_REF" --sha "$PROMO_SHA"

# merge + Vercel rollout + /api/ready gate (needs VERCEL_AUTOMATION_BYPASS_SECRET: the project has
# ssoProtection=all_except_custom_domains, so a bare curl gets a 401 and deploy.sh fails closed)
export VERCEL_AUTOMATION_BYPASS_SECRET=…
./scripts/deploy.sh --pr "$PROMO_PR" --env production
```

**Do not pass `--skip-migrate`.** 4.4 already applied the DDL, so the migration workflow has nothing
left to do and re-running it is idempotent — `decide_skip_migrate` returns `refuse-production` whenever
`--skip-migrate` is combined with a changed `drizzle/` diff, and the script exits before merging.
Passing the flag here is the one thing guaranteed to stop this deploy.

### 4.6 Prove it works, in this order

1. `curl -fsS -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
   https://solara-production.vercel.app/api/ready` → `{"ok":true}`. A 401/403 means the bypass
   secret is wrong, not that the app is down.
2. **Sign up** — the first account on the new database.
3. **Receive the verification email** from the verified Resend domain, then verify → the account
   becomes able to hold a session (`auth.ts` requires `emailVerifiedAt`).
4. **Sign in**, then **password reset** round trip. Reset touches the same mail path, so if 3 worked
   this almost certainly does — but it is a separate route and worth one minute.
5. Confirm `/api/ready` is **still** `{"ok":true}` after a real user row exists (proves the schema
   checks pass with data, not just empty tables).

If step 3 fails with a Resend 403/422, the sending domain is unverified — go back to §3, fix the
domain, and note that no redeploy is needed unless `MAIL_FROM` itself changes.

---

## 5. What this deploy does **not** fix (do not treat as regressions)

- **No scheduled job exists** (`crons.definitions` is empty). `rate_limits` and `email_tokens` grow
  unbounded; `npm run rate-limits:cleanup` and `#66` (expired sessions) have nothing calling them.
- **No error tracking** (`#77` open) — a production failure is found by a user report. This is why
  §4.6 is manual rather than "wait for green".
- **`ssoProtection`** keeps the production URL behind a Vercel login for anyone outside the account.
  Fine for a prototype; decide before an uptime monitor or a stranger needs it.
- **CSP is report-only** (`#57` stays open until an observation window is clean).
- **Readings stay dark** (`READINGS_*` unset). Nothing LLM-related runs.

## 6. Docs to correct once the deploy is done

These currently claim production is unprovisioned, which this deploy falsifies:

- `#52`'s closing comment ("production is still unprovisioned") — add a superseding note.
- `docs/operations/promotion-2026-11-10.md` §0/§1 — mark HAZARD A resolved by the empty database.
- `BACKLOG.md` — it has no row for `#126`, `#127`, `#128`, `#129`, `#130`, and still lists `#122` as
  an open PR.
- Close on promotion, only after §4.6 passes: `#53 #54 #55 #56 #60 #64 #70 #72 #78 #84 #87 #103 #119`.

## 7. Remaining open items I could not close

1. **Resend sending domain** — must be verified before §4.6 step 3 can pass. This is yours; I cannot
   see or change Resend from here.
2. **`VERCEL_AUTOMATION_BYPASS_SECRET`** — must be in the deploying shell, or `deploy.sh` fails
   closed by design.
3. **LLM vendor decision** — still not needed for this deploy; still blocks the flag ever being
   turned on. Sequence unchanged: `#105` consent → provider adapter → `#104` → `#107` → `#109`.
