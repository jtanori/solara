# Production deployment readiness audit — 2026-11-10

Scope: what must be true before `staging → main` can be promoted, what is verified vs. inferred, and
whether the LLM/readings feature is a blocker.

Method: repository inspection + the Vercel connector (project/env-var **keys** only, no secrets read)
+ replaying the repo's own gates. Every claim below is tagged **[verified]** or **[inferred]**.

---

## 1. Verdict

**The LLM is *not* a production blocker for this promotion, and it should not be worked on now.**
The readings pipeline ships dark (`READINGS_GENERATION_ENABLED` defaults `false`, and `PROVIDERS`
contains only `fixture`), so nothing LLM-related runs in production after the merge. Deferring it
costs nothing; building it now would add an unverified vendor dependency to a release whose actual
blockers are elsewhere.

**The real blocker is smaller than the last runbook assumed: production deploys do not start from
`main`.** See §3, which supersedes one recommendation in `promotion-2026-11-10.md`.

Production is **not** ready to accept users, but it *is* ready to receive this promotion once the
four items in §5 are settled. Launch (open sign-up) is a separate, later gate.

---

## 2. What I verified about production (Vercel connector)

Project `solara` (`prj_IKhfjZr67qbg3s0qvDPVhbqqlMwl`), Next.js, git-linked to `jtanori/solara`,
production branch `main`, plan **hobby**.

### Deployments [verified]

`main` **does** deploy to production. Every promotion so far produced one:

| Commit | Target | State |
|---|---|---|
| `4490ced` "Merge pull request #51 …" | production | READY |
| `ade651e` "Merge #49 …" | production | READY |
| `03467bd` "Merge #46 …" | production | READY |
| `039d9b6` "promote … (#42)" | production | READY |
| `e779bec` (PR #36) | production | **ERROR** — `npm run build` exited 1 |

So the pipeline works, and there is a real build-failure precedent on `main` (`e779bec`). The
current live production build is `4490ced`, dated 2026-11-07.

### Production environment variables [verified: names only]

Present for `production`: `DATABASE_URL`, `APP_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_ID_MXN`, `STRIPE_PRICE_ID_USD`, `STRIPE_PREMIUM_PRICE_IDS`, `OPEN_METEO_API_KEY`,
`NEXT_PUBLIC_MAP_TILE_URL`, `NEXT_PUBLIC_MAP_ATTRIBUTION`.

**Missing for `production`, and required by code that ships in this promotion:**

| Missing | Required by | Consequence |
|---|---|---|
| `MAIL_TRANSPORT` | `resolveMailTransportName()` — **throws in production** | see §4, this is the blocker |

All values are `sensitive`, so I did not read any. Presence is not validity — `.env.example`
documents `?sslmode=verify-full&channel_binding=require` for the direct URL, and only a real
connection proves it.

Also absent, but **defaults are correct**: `CSP_MODE` (→ `report-only`), `DB_POOL_MAX`,
and all five `READINGS_*` (→ generation off).

### Protection and domains [verified]

- `ssoProtection.deploymentType: "all_except_custom_domains"` — a Vercel login wall on deployment
  URLs. This is why `deploy.sh`'s `/api/ready` poll needs `VERCEL_AUTOMATION_BYPASS_SECRET`.
- Production hostname `solara-production.vercel.app` exists and is verified; staging hostname
  `solara-stg.vercel.app` is branch-linked to `staging`.
- `gitProviderOptions.createDeployments: "disabled"` with `disableRepositoryDispatchEvents: true` —
  deploy creation is not driven by the Vercel GitHub app; it follows the git integration on the
  configured production branch.
- `crons: { definitions: [] }` — **no scheduled job exists**, which matters in §6.

### Production database [verified as absent, inferred as empty]

All 11 `migrate.yml` runs in repository history target **staging**; there is not one production run.
`DATABASE_URL` exists in the production environment, and #52's own resolution says production is
still unprovisioned ("the same `42P01` will happen there on first auth"). Therefore the first
production `migrate` creates the **entire schema** `0000 → 0003`, not three incremental migrations.
I could not read the database directly — that requires the production Environment, which is correct.

---

## 3. Correction to the previous runbook: the promotion PR is not the deploy trigger

`promotion-2026-11-10.md` assumed the promotion must be merged via `scripts/deploy.sh` and that the
freshness gate therefore had to be satisfied. Verified detail changes the picture:

- `deploy.sh` refuses the promotion today (`merge-base --is-ancestor origin/main origin/staging` →
  exit 1). That stands.
- **But `deploy.sh` is a wrapper around `gh pr merge`.** Its value is the migrate + schema + readiness
  gates it sequences. It is not the mechanism by which Vercel deploys: Vercel deploys any new commit
  on the production branch.
- Its post-merge `/api/ready` poll cannot run from this environment anyway (Vercel is unreachable
  here, HTTP `000`).

So there are three viable paths, in order of risk:

| Path | Freshness gate | Migrations | Readiness proof | Verdict |
|---|---|---|---|---|
| A. Back-merge `main → staging`, then `deploy.sh --pr` | satisfied | automated | automated | **safest, most work** |
| B. Back-merge, then `gh pr merge --merge` by hand, migrate first | satisfied | **manual** (runbook step 4) | manual (`/api/ready` from a networked shell) | acceptable if A is unavailable |
| C. Merge without the back-merge (`gh pr merge` directly) | bypassed | manual | manual | works, but skips the gate that exists to stop exactly this |

Recommendation: **A if you can run `deploy.sh` somewhere with Vercel access, otherwise B.** Do not
use C to save ten minutes on a first-ever production migration.

The back-merge remains correct advice: `main` has nothing `staging` lacks (`git diff
origin/staging...origin/main` is empty, trial-merge tree byte-identical), so it costs one merge
commit and makes the repo's own gate usable.

---

## 4. The one hard blocker: `MAIL_TRANSPORT` is not set in production

This is worse than "email won't send". Traced through the code:

1. `resolveMailTransportName()` — if `MAIL_TRANSPORT` is unset **and** `NODE_ENV === "production"`,
   it **throws** `MailConfigurationError`. It does not fall back to `outbox`.
2. The callers pass it lazily: `mail: () => createMailTransport()` in
   `src/app/api/auth/{route,verify/request,reset/request}`, so the throw happens **inside the
   request**, not at boot.
3. `0002_email_verification` deletes every session for every user whose `email_verified_at IS NULL`
   — which is every pre-existing user at apply time — and `src/lib/auth.ts` requires
   `isNotNull(users.emailVerifiedAt)` to hold a session.
4. Verification requires sending mail. With `MAIL_TRANSPORT` unset, every send path throws.

**Net effect on production:** after migration + deploy, no existing user can hold a session, and no
user can complete verification or reset — **every login path is dead, for everyone.** That is a
worse outage than the #52 incident it is meant to fix, and `/api/ready` will not catch it: readiness
probes the database and schema only; nothing checks mail.

Fix before migration: set `MAIL_TRANSPORT` (`resend`|`postmark`) plus `MAIL_FROM` and the matching
API key/token in the production environment. Then redeploy, because `sensitive`/`env` values are
baked at build time for server functions reaching Vercel env.

**Second-order decision, still yours:** the `0002` `DELETE` is a data-destroying statement in a
first-ever migration. With ADR 005 (no real customers) it is almost certainly acceptable, but it
must be a recorded choice. Mitigation if not: `UPDATE "users" SET "email_verified_at" = now();`
between migrate and deploy.

I could not confirm whether production holds any real accounts — that needs the production database,
which only the Environment can reach. If it does, this decision matters much more.

---

## 5. Pre-promotion checklist

Blocking:

1. **Set `MAIL_TRANSPORT` + `MAIL_FROM` + provider key in production** (§4).
2. **Decide the `0002` session-wipe**: accept, or seed `email_verified_at` post-migrate.
3. **Take a Neon snapshot of `solara-prod`** before the first migrate (ADR 008: no down migrations;
   recovery is forward fix or point-in-time restore).
4. **Run `node scripts/check-setup.mjs production --strict`** in a shell that has the production
   environment. Presence of a variable is not validity.

Then: back-merge → freeze SHA → staging rehearsal → production migrate (`--rehearsal-pr`) →
`db-remote --check --env production` → merge → `/api/ready` → manual sign-up/sign-in/verify/reset.

`#77` (error tracking) remains open. That means a production failure is discovered by a user report,
as #52 was. It is not a merge blocker for a prototype, but it is the reason to do the manual checks
in step 6 rather than trusting a green deploy.

---

## 6. Launch blockers this audit newly surfaces

These are *after* the promotion, but they are cheap now and expensive later:

1. **Nothing purges `rate_limits` or `email_tokens`,** and there is **no cron** (`crons.definitions`
   is empty). `0001` creates `rate_limits` with an `expires_at` index and a `rate-limits:cleanup`
   script exists, but nothing calls it on a schedule. Left alone, those tables grow without bound —
   and `#66` (purge expired sessions) is still open, so sessions do too.
2. **`ssoProtection: all_except_custom_domains`** means the production URL requires a Vercel login
   for anyone outside the account. That is fine for a prototype and blocks any external readiness
   probe; decide before handing the URL to a user or an uptime monitor.
3. **No custom domain** — only `*.vercel.app`. Fine, but `APP_URL` and email templates should not be
   finalized against a domain you intend to change.
4. **Hobby plan.** `#88`/`#90` (supply chain, secret rotation) and `#77` all assume an operational
   surface that Hobby limits; also confirm the plan's terms are acceptable for a paid product.

---

## 7. Do we need to define the LLM stuff before production?

No — and here is the decision framework for when we do.

**Why it is not blocking now**

- Generation is dark: `generationEnabled()` returns `process.env.READINGS_GENERATION_ENABLED === "true"`
  and the variable is absent in production.
- The provider registry is `{ fixture }` only, so even a flipped flag produces deterministic
  synthetic prose, not model output. No SDK, no key, no spend.
- `POST /api/readings` generates after the save behind that flag. Off = no new behaviour.

**What must exist before the flag is ever turned on**, in dependency order:

| Order | Item | Why it blocks the flag | Status |
|---|---|---|---|
| 1 | **Consent capture** (#105, p0) | No generation path may bypass it; also the legal basis for sending derived data out | not built |
| 2 | **A real provider adapter** | **No issue exists for this.** `PROVIDERS` = `{fixture}`; the seam is explicitly documented as a "config-selected drop-in" | missing |
| 3 | **Vendor + budget decision** | Sets `READINGS_CHEAP_MODEL`/`STRONG_MODEL`, `READINGS_MODEL_PRICES`, hence whether the 5/10 MXN ceilings hold | undecided |
| 4 | **Price table in MXN** | `modelPrices()` fails closed on unpriced models — by design, so an unpriced real model means zero dispatch | config only |
| 5 | **Eval harness + astrologer gate** (#109, p1) | Quality gate before paying customers read it | not built |

**The good news**: the machinery a real provider needs already exists and is tested — strict JSON
Schema, one repair attempt, cache-freeze, per-section cost/latency ledger, tier ceilings that fail
closed, and a PII-free digest. Adding a provider is one module implementing `ReadingProvider` plus a
price entry, not a pipeline change. That is why it is safe to defer.

**Recommendation**: promote first. Then do them in this order: **#105 consent → provider adapter +
vendor decision → #104 free tier → #107 paid → #109 eval**. #105 first because it is p0 and because
it is the only one that *cannot* be added later without a migration and a privacy-policy revision.

---

## 8. Readings correctness shipped in this audit (not a blocker, but open against live code)

`#128` and `#129` were open against the accounting code that this promotion deploys. Both are now
fixed on this branch, in one PR as both issues requested.

- **#129** — a provider that always reports invalid usage dispatched the whole tier while the ledger
  read `0 / 0`, so the ceiling had nothing to gate. Now the first unmeasurable report **halts the
  run**: no further section is dispatched, the remainder fails `generation_halted: …`, and the
  attempt is booked at a **worst-case estimate** (`maxOutputTokens × price + prompt estimate`) so
  `costMxn + wastedCostMxn` stays finite, honest, and ceiling-gated. `pricing_unavailable` is
  deliberately excluded — it is a deterministic configuration error and halting on it would change
  established fail-closed behaviour for the whole table.
- **#128** — the repair branch of the usage guard had no test (disabling it left 39/39 green). Two
  tests now cover it: a repair reporting NaN usage, and a repair reporting an unpriced model. Both
  assert the scenario still fails closed with the *original* `invalid_output` reason.

Evidence: 44/44 readings tests pass; full suite 212 tests / 198 pass / 10 fail / 4 skip, where the 10
are the pre-existing DB-env class (baseline before my change: 207 / 193 / 10 — identical failure
set, +5 tests added). `tsc` clean, `eslint --max-warnings=0` clean, `npm run build` exit 0.

Mutations run per `docs/CODE_REVIEW.md` §5, each caught:

| Mutation | Result |
|---|---|
| `if (false && repairPricingFailure)` (issue #128's exact criterion) | 37 pass / **2 fail** |
| `if (false && runHalted)` | 36 pass / **3 fail** |
| estimate booked as `+= 0` | 37 pass / **2 fail** |
| estimate uses `outputTokens: 0` instead of the budget | 38 pass / **1 fail** |

---

## 9. Open questions for the operator

1. Does production hold any account you care about? (Drives the `0002` session-wipe decision.)
2. Which mail provider — Resend or Postmark? (Blocks item 1 of §5.)
3. Can you run `deploy.sh` from a shell with Vercel access, or should I prepare path B?
4. For the LLM: which vendor and rough per-reading budget? Not needed today, but it is the one
   decision that unblocks #105-adjacent work cleanly.
