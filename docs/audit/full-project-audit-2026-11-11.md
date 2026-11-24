# Solara — full project report and audit

**Date:** 2026-11-11 · **Audited ref:** `staging` @ `e030672` (59 commits, last 2026-11-11)
**Method:** everything below is read from the repository or the live GitHub API at audit time. Where a number was measured, the command is given. Where a claim is unverified, it says so.

---

## 1. What this project is

**Solara** is a bilingual (English/Spanish) web application that produces *solar-return readings* — an astrological "year ahead" document computed from a person's birth data — and sells access to a deeper version by subscription.

From `package.json`: `nextjs-postgresql-template` (the name was never changed from its scaffolding origin). From `README.md`:

> A bilingual solar-return prototype with Stripe subscriptions, city search and map selection, private editorial PDFs, and role-based content editing.

Concretely, the product asks for birth date/time/place, computes the solar-return chart (the moment the Sun returns to its natal position), renders a chart wheel and geocoded map, and gates an editorial reading behind a free/Premium tier. It is explicitly **not production-ready** — `README.md` §Launch limitations and ADR 005 both say so.

**Stack:** Next.js 16 (App Router, React 19) · TypeScript · PostgreSQL via Drizzle ORM (`pg`) · Stripe · Vercel hosting · Neon database.

---

## 2. Features

### Implemented and reachable

| Feature | Where |
| --- | --- |
| Marketing homepage, bilingual, chart-wheel hero | `src/app/page.tsx` |
| Birth-data intake + city search with map | `src/app/create/`, `src/lib/places.ts`, Leaflet |
| Solar-return calculation | `src/lib/solar.ts`, `src/lib/astro.ts` (`astronomy-engine`) |
| Chart v2 — ten bodies, ASC/MC, nodes, aspects | `src/lib/chart.ts`, migration `0003`, validated against Swiss Ephemeris (#102, #112) |
| House systems — whole-sign + Placidus | `src/lib/chart.ts` (#101, #122) |
| Editorial PDF download | `src/app/api/readings/[id]/pdf/`, `@react-pdf/renderer` |
| Sample reading (public) | `src/app/sample/` |
| Stripe subscriptions — Checkout, webhook, portal | `src/app/api/billing/*`, `src/lib/billing.ts` |
| Auth — sign-in, mailbox claim, email verification, password reset, rate limiting, session revocation | `src/lib/auth*.ts`, `src/lib/rate-limit.ts`, `src/lib/account-lock.ts` |
| Roles — `user`/`editor`/`admin`/`owner` with server-side gates | `src/lib/auth.ts`, `src/app/admin/` |
| Role-scoped usage guide | `src/app/usage-guide/` (#13) |
| Internal docs hidden outside dev (`/blueprint`, `/setup` → 404) | `src/lib/development.ts` (#12, #14, #15) |
| AI reading generation — 9-section pipeline, prompt registry, schema validation, DB cache, cost ledger, freeze | `src/readings/` (#103, #127) |
| Liveness/readiness split with schema + migration verification | `/api/health`, `/api/ready` (#70, #64) |
| Strict origin checks, security headers, CSP report-only | `src/lib/request-security.ts`, `src/lib/security-headers.ts` (#56, #57) |
| PII-redacting structured logs | `src/lib/log.ts` (#87) |

**Reading sections (11 keys, `src/readings/types.ts`):** `overview`, `sun`, `moon`, `ascendant`, `aspects`, `houses`, `planets`, `nodes`, `planetaryYear`, `transits`, `guidance` — the first two are free-tier with a required "cliffhanger" closing question enforced by schema.

### Built but gated or incomplete

- **AI readings** sit behind `READINGS_GENERATION_ENABLED` (`src/readings/config.ts:97`). The pipeline exists; the *renderer* (#106), *free-tier teasers* (#104), *paid-section generation on entitlement* (#107) and *astrologer review gate* (#109) do not.
- **Profections and transits** (#110) — not implemented; `transits` is a schema key with no engine behind it.
- **Staff MFA** (#58), **repeatable backup/restore drill** (#62), **error tracking/alerts** (#77) — open.
- **`/usage-guide`, `/blueprint`, `/setup`** exist but are internal tooling, not customer features.

---

## 3. Current development status

**Measured at `staging` @ `e030672`, after `npm ci`:**

| Check | Result |
| --- | --- |
| `npx tsx --test tests/*.test.ts` (no `DATABASE_URL`) | **252 tests, 238 pass, 10 fail, 4 skipped** |
| same with a dummy `DATABASE_URL` | **289 tests, 250 pass, 2 fail, 37 skipped** |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests scripts --max-warnings=0` | clean |
| `tests/deploy-policy.test.ts` + `vercel-preview-lib` | 20/20 pass |
| CI on `staging` (`verify`, run 42979755970) | **success** |

The 10 failures without a database are the #135 defect: `src/db/index.ts:9` throws at module load, so 8 test files' `skip:` guards are unreachable. With a live-shaped URL they drop to the 2 tests that genuinely need a database (`readings-db` cache roundtrip, `reading_documents` freeze).

**Shape of the codebase:** 135 files under `src/`, 39 modules in `src/lib/`, 50 test files, 18 operational scripts, 34 docs, 4 migrations, 10 tables.

**Milestone progress (live):**

| Milestone | Open | Closed |
| --- | --- | --- |
| M1 - Foundation | 18 | 8 |
| M2 - Billing | 1 | 1 |
| M3 - Launch readiness | 41 | 10 |
| Final - Platform validation | 0 | 1 |
| *(no milestone)* | 1 | — |
| **Total open** | **61** | |

**Honest summary:** the foundation and the astrology engine are in good shape and heavily tested. The *content* product (AI readings → rendered page/PDF → paid entitlement) is roughly half-built: the hard part (pipeline, schemas, caching, cost accounting) exists; the customer-facing half is issues #104–#107, #109–#111. **`staging` is 18 commits ahead of `main`** and nothing has ever gone through a promotion to production.

---

## 4. Backlog — issues and milestones

61 open issues. Grouped by theme; `→` marks priority.

### M1 — Foundation (18 open)
`p1` #63 single source of truth for `DATABASE_URL` + preview-DB policy · #60 explicit DB pool + TLS · `p2` #65 indexes for dashboard/session/audit (**blocked**) · #66 purge expired sessions · #67 change password · #68 sign-out-everywhere · #69 re-auth for destructive actions · #71 schema/readiness docs into AGENTS.md · #83 realtime channel decision · #86 error boundaries + 404/loading · #91 typed env module · #92 e2e smoke + coverage floor · #93 remove `users.plan` · #94 incident-response runbook · `p2` #135 DB tests fail instead of skipping · #136 `deploy.sh --dry-run` · #138 build-number probe · `p1` #134 make review completion procedural

### M2 — Billing (1 open)
`p2` #10 Stripe test-mode subscription lifecycle (**blocked**)

### M3 — Launch readiness (41 open)
**p0:** #53 rate-limit auth + non-blocking scrypt · #54 email transport + verification · #55 password reset (awaiting-promotion) · #105 AI consent + privacy copy · #131 mail transport/secrets for staging+prod
**p1:** #56 CSRF/same-origin hardening · #57 security headers + CSP · #58 TOTP MFA · #59 separate app/migration DB roles · #62 backup/restore drill · #64 migration drift check (awaiting-promotion) · #70 health/ready split (awaiting-promotion) · #72 ADR 006 · #74 journal integrity · #75 gated migrate pipeline · #76 **`deploy.sh` fail-closed (in progress)** · #77 error tracking/alerts · #78 ADR 007 · #79 pipeline + auth hardening gate · #81 PDF artefact storage · #82 retention/export/erasure · #84 harden `/api/places` · #85 legal pages/consent/SEO · #87 log redaction (done in code, issue open) · #88 supply-chain controls · #89 CODEOWNERS/approvals · #90 secret inventory + rotation · #99 reading-document epic · #103 generation pipeline · #104 free-tier teasers · #107 paid sections on entitlement · #108 cost caps + kill switch · #109 eval harness + astrologer gate · #119 exact-SHA migrate for promotion · #128/#129 readings guard follow-ups
**p2:** #106 page + PDF renderer · #110 profections and transits
**p3:** #111 astrologer override tooling · #93 `users.plan` removal

### Not in a milestone
#134 — make PR review completion procedural (**p1**)

### Recently closed (evidence of velocity)
#117, #116, #102, #101, #73, #52, #16, #15, #14, #13, #12, #11

---

## 5. Project structure

```
solara/
├── src/
│   ├── app/                     Next.js App Router — 14 route groups + 19 API routes
│   │   ├── api/                 health, ready, auth, billing, places, readings, admin…
│   │   ├── create/ dashboard/ reading/[id]/ sample/ pricing/ account/
│   │   └── blueprint/ setup/ usage-guide/     (internal, dev-gated)
│   ├── components/              site shell, footer, chart wheel, PDF, guides
│   ├── db/                      schema.ts (10 tables), index.ts (pooled, throws w/o URL)
│   ├── lib/                     39 modules — astro, chart, solar, auth, billing,
│   │                            rate-limit, readiness, log, places, mail, i18n…
│   └── readings/                AI pipeline: config, types, schemas, registry,
│                                prompts/ (23 bilingual .md), generate, db-cache,
│                                document, content-version, provider
├── drizzle/                     0000_initial → 0003_readings_documents_generation_cache
├── tests/                       50 files (node:test via tsx)
├── scripts/                     18 — deploy.sh, db-run.ts, db-remote.ts,
│                                check-setup.mjs, pr-lint.mjs, backlog-snapshot.ts,
│                                lib/{deploy-policy,vercel-preview,vercel-rollback}.sh
├── docs/
│   ├── decisions.md             9 ADRs — the canonical "why"
│   ├── operations/              6 runbooks (bootstrap, checklist, promotion,
│   │                            migration gate, readiness audit, triage)
│   ├── setup/                   11 guides + env-templates
│   ├── audit/                   dated audits, including this one
│   ├── deploys.md               append-only deploy record (#76)
│   └── CODE_REVIEW.md, PR_WORKFLOW.md
├── .github/workflows/           ci.yml (pr-lint + verify), migrate.yml
└── drizzle.config.ts, next.config.ts, package.json
```

**Conventions:** one ADR per irreversible decision; runbooks under `docs/operations/`; every test file a sibling of the module it covers; scripts split into `.ts` (Node tools) and `.sh` (ops with `lib/` helpers).

**Database (10 tables):** `users`, `sessions`, `readings`, `reading_documents`, `generation_cache`, `knowledge`, `subscriptions`, `stripe_events`, `audit_logs`, `email_tokens`, `rate_limits`.

---

## 6. Deployment process

**Topology:** one Vercel project (`solara`, `prj_IKhfjZr67qbg3s0qvDPVhbqqlMwl`, team `team_MyTwcVzABQrWXY7JvB8qqhlS`, Hobby). `main` is the production branch; `staging` is a preview alias. **One project, two environments, separate Neon databases** (`solara-staging`, `solara-prod` per ADR 008).

**`scripts/deploy.sh` — the single deploy entry point.** Gates, in order (`grep -n '^echo "== Gate' scripts/deploy.sh`):

1. **Base freshness** (line 84) — the PR head must contain the base tip; otherwise a trial `git merge-tree` runs and the script refuses a stale PR. For `main` this gate *is* the ancestry check.
2. **Preview readiness** (line 158) — resolves the PR's own Vercel preview from the head SHA's commit status and requires `/api/ready → {"ok":true}` **before** merging. Fails closed on no status, unresolvable URL, or non-ok probe; 401/403 aborts immediately with an instructional message.
3. **CI checks** (line 194) — `gh pr checks --watch`, then requires `mergeStateStatus=CLEAN`.
4. **Hosted schema check** (line 365) — dispatches `.github/workflows/migrate.yml` in `verify`-only mode against the reviewed SHA (read-only, no DDL) and requires `in sync`.
5. **Merge** — `gh pr merge --match-head-commit <sha>`; `--squash` for `feature → staging`, `--merge` for `staging → main`.
6. **Post-merge** — waits for the Vercel status on the merge SHA, then probes the environment URL's `/api/ready`.
7. **Record** — appends to `docs/deploys.md` and publishes a `<!-- deploy-record -->` PR comment (rewritten in place on retry); production merges also create a `deploy/production/<date>-<sha>` release.

**Rollback:** production-only, via Vercel Instant Rollback, using a target captured before the merge — and only when `VERCEL_TOKEN` + `VERCEL_PROJECT_ID` are set. Staging has **no** automatic rollback by design (Instant Rollback only moves the production alias). Schema rollback is a forward fix or a Neon point-in-time restore, never a down migration (ADR 008).

**Reality check:** `docs/deploys.md` contains **one** row. Nothing has been deployed through `deploy.sh` end to end; the one staging deploy that happened (#133 → `d7d7634`) was merged manually with `gh pr merge` because the interactive run was blocked, and its record was written by hand. **No production deploy has ever occurred.**

---

## 7. Development process

**Branching (ADR 001):** `staging` is long-lived; features branch from it as `<type>/<issue>-<slug>`; flow is `feature → staging` (reviewed PR) → QA → `staging → main` promotion → production.

**Merge policy (ADR 001/004):** squash for features (one commit per feature), merge commit for promotions (preserves ancestry). Repo settings verified live: `allow_squash_merge:true, allow_merge_commit:true, allow_rebase_merge:false, delete_branch_on_merge:true`.

**Branch protection — two rulesets, verified live:**

| ruleset | target | rules | strict? |
| --- | --- | --- | --- |
| `protect-staging` (26759336) | `refs/heads/staging` | deletion, non-fast-forward, **linear history**, required checks, PR | yes (`verify`) |
| `protect-main` (26759381) | `~DEFAULT_BRANCH` | deletion, non-fast-forward, required checks, PR — **no linear history** | yes |

Required approvals are **0** in both (single collaborator; ADR 004 deliberately uses COMMENT-only reviews). Conversation resolution is required.

**CI (`.github/workflows/ci.yml`)** — two jobs: `pr-lint` (advisory) and `verify` (required): `npm ci` → `db:manifest:check` → `db:migrate` → `db:check` → `next typegen` → `tsc --noEmit` → `eslint --max-warnings=0` → full test suite → `npm audit --omit=dev --audit-level=high` → `next build` → boot-and-smoke `/api/health` + `/api/ready`.

**Tests:** `node:test` through `tsx`, 50 files, no test framework. DB-touching suites are opt-in via `RUN_INTEGRATION_TESTS` / `RUN_BILLING_INTEGRATION_TESTS`.

**Documented workflow:** `docs/PR_WORKFLOW.md`, `docs/CODE_REVIEW.md`, `AGENTS.md`. PR template requires `## Linked issue` + `## Evidence`; `pr-lint` enforces a `type:*` label and a `deploy:required|skip` classification.

**Migration policy (ADR 008):** one migration per PR; `drizzle-kit generate`, never `push` on hosted; applied migrations immutable; expand/contract for breaking changes; migrate before deploy.

---

## 8. Remote services

| Service | Role | Evidence in repo | State |
| --- | --- | --- | --- |
| **Vercel** | Hosting, previews, production, Instant Rollback | `scripts/lib/vercel-*.sh`, `docs/setup/01-*` | Live. Hobby plan. `ssoProtection: all_except_custom_domains` — preview probes need `VERCEL_AUTOMATION_BYPASS_SECRET`. |
| **Neon** | PostgreSQL (pooled for app traffic, direct for migrations) | ADR 008, `docs/setup/01-*`, `src/lib/database-url.ts` | Documented as the DB provider; `solara-staging` / `solara-prod` databases named in ADR 008 |
| **Stripe** | Subscriptions, Checkout, webhook, customer portal | `src/lib/billing.ts`, `stripe-sync.ts`, `stripe-events.ts`, migration `0001` | Test mode only; `#10` blocked on validating the lifecycle |
| **Resend / Postmark** | Transactional email (`MAIL_TRANSPORT`) | `src/lib/mail.ts`, `email-messages.ts`, `.env.example` | **Not configured** — #131 (p0). Local uses `.mail-outbox/` |
| **GitHub** | Source, CI, rulesets, Environments (`staging`/`production` hold `DATABASE_URL`), Actions for migrations | `.github/`, ADR 001/008 | Live; 2 rulesets, 2 workflows |
| **Open-Meteo** | Geocoding for city search | `src/lib/places.ts`, `docs/setup/03-*` | Optional key; public endpoint when absent |
| **Map tiles** | Leaflet basemap | `NEXT_PUBLIC_MAP_TILE_URL` | Configurable; licensing unreviewed |
| **LLM provider** | AI reading generation | `src/readings/provider.ts`, `READINGS_PROVIDER` | Provider-agnostic, **unset**; feature flag off |
| *Dependabot* | Dependency updates | `.github/dependabot.yml` | Active (13+ open update runs at audit time) |

---

## 9. Outstanding issues — what is actually wrong

Ranked by how much it has cost, not by label.

**1. The deploy path has never been exercised.** This is the dominant risk. `deploy.sh` is elaborate and tested against stubs, but: no migration has run on a hosted DB through `migrate.yml` except the read-only `verify`; no release marker has been created; `vercel_promote_deployment` has never been called; the one staging deploy bypassed the script entirely. Every rollback claim in ADR 008 is untested (#62, #76).

**2. `deploy.sh` found a real bug the first time it was run for real.** #133's preview resolver required a digit in the deployment id; real Vercel ids are base62 and often contain none (`aVrhDtYTxMXZpWmWQxZGSVdAhMXT`). Stubs used `dpl_abc123`. Fixed in `002e7b0`, but it is direct evidence that stub-verified ≠ verified.

**3. #135 — 10 tests fail instead of skipping without `DATABASE_URL`.** `src/db/index.ts:9` throws at module load, so guards in 8 files never execute. Measured: 252/238/10/4 without a URL versus 289/250/2/37 with one. This is why "run the tests" is ambiguous in every conversation.

**4. The content product is half-built.** The pipeline (#103) is done; the renderer (#106), free teasers (#104), paid entitlement generation (#107), and the astrologer review gate (#109) are not. Readings are also off by default (`READINGS_GENERATION_ENABLED`).

**5. Mail is unconfigured (p0, #131 / #54).** Email verification and password reset are implemented but cannot deliver on staging or production.

**6. Review process is prompt-dependent (#134).** Five rounds on #133 were spent on findings that a checklist would have caught — contradictory tables, a documented command that always refuses, a claim reversed relative to the tool's actual behaviour. The process relies on a reviewer's diligence rather than a runnable check.

**7. Documentation kept disagreeing with itself.** #133's review found the same class of defect repeatedly: a runbook asserting JSON formatting backwards, two tables attributing a block to the wrong ruleset, "supported routes" that did not exist in code. Docs are treated as claims here; several were false.

**8. Nothing is deployed to production, and 18 staging commits are pending.** The gap to `main` grows with each merge, and `protect-main` has no linear-history rule, so promotion needs a merge commit.

**9. Small but real:** #65 blocked on index design · `users.plan` still a vestigial entitlement source (#93) · `scripts/lib/wait-for-vercel-status.sh` has a latent `$state` vs `$last_state` bug · the repo is still named `nextjs-postgresql-template`.

---

## 10. Review and promotion strategy — what we have actually followed

### The documented strategy (ADR 001 + 004)

1. Feature branch from `staging` → PR → review → squash-merge.
2. Comment-only reviews, approvals **0** (solo maintainer), but **conversation resolution required**.
3. `staging → main` promotion via a **merge commit**, never a squash, so `staging` stays an ancestor of `main`.
4. Production only after the ADR 003 platform-validation checklist.

### What actually happened

**Six review rounds on #133** — this is the most informative artifact in the project.

| Round | Finding | Cause |
| --- | --- | --- |
| 1 | SEC-01: unpriced model dispatched the paid tier free; release record local-only; rollback could hit the wrong environment | genuine defects, fixed |
| 2 | Path B (a promotion route) documented but the helper had been deleted in the same commit | doc/code drift |
| 3 | a fenced `gh api` command ending in `...` was not executable | pseudo-command shipped as instruction |
| 4 | TTY-vs-pipe output claim reversed relative to `gh`'s real behaviour | measured wrongly, asserted confidently |
| 5 | ruleset scope attributed to `protect-staging` when `protect-main` blocks the promotion | two live rulesets conflated |
| 6 | **two contradictory tables in the same section** — the correction was added beside the original instead of replacing it | failure to delete the superseded copy |

Three of those six were *documentation* defects, and all three had passed the tests written to prevent them. The recurring lesson is recorded in the repo's own history: **presence-only tests are not enough**. The fixes now assert *direction* (not just that "compacts" appears), count structural markers (table separators, not a specific header), and are mutation-checked in both directions.

**Promotion strategy, actual state:** zero promotions. `main` sits 18 commits behind `staging`. The promotion runbook (`docs/operations/promotion-2026-11-10.md`, `production-bootstrap-2026-11-10.md` §4.1a) was rewritten several times during #133 and now correctly states the one supported route: a back-merge that is **not** a squash (a squash lands content but not ancestry, so `protect-main`'s strict check still refuses it), with `required_linear_history` lifted on `protect-staging` only for the merge, then restored.

**Review mechanics that work:** COMMENT verdicts per SHA, every finding answered with the fix commit and re-run evidence, mutations checked in both directions, and unverified claims explicitly labelled unverified. **Review mechanics that failed:** treating a doc fix as done without reading the file back (a Python patch aborted mid-way and reported success), and trusting a test's title over what it asserted.

---

## Appendix — commands used

```bash
npx tsx --test tests/*.test.ts                  # 252/238/10/4 without DATABASE_URL
DATABASE_URL=postgres://u:p@127.0.0.1:59999/none npx tsx --test tests/*.test.ts   # 289/250/2/37
npx tsc --noEmit ; npx eslint src tests scripts --max-warnings=0
gh issue list --state open -L 200 --json number,milestone
gh api repos/jtanori/solara/milestones
git rev-list --count origin/main..origin/staging      # 18
grep -n '^echo "== Gate' scripts/deploy.sh
```
