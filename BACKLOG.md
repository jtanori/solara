# Backlog — Solara

> **Source of truth:** [GitHub Issues](https://github.com/jtanori/solara/issues) are authoritative. This file is an **offline index** only — it lists every issue with a link and a snapshot of its lifecycle at the time of the last update. Update this file only when issues are created, changed, or closed; do not duplicate status tracking here. See `docs/decisions.md` ADR 002 and `AGENTS.md`.

*Milestone routing corrected 2026-11-08 (#62→M3, #63/#94/#69→M1; audit severity decides).*

*Last updated: 2026-11-09 from `staging` at `c938569` — auth/security hardening fixes in progress on `feat/53-54-56-57-auth-security-hardening` (#53, #54, #56, #57); production migration gate split to #119.*

## Open

| # | Title | Labels | Status |
|---|-------|--------|--------|
| [#6](https://github.com/jtanori/solara/issues/6) | chore: enable Dependabot alerts and security updates | `type:deps` `area:infra` `priority:p2` `status:ready` | ready — `dependabot.yml` `target-branch: staging` landed in #23; first update run + repo Alerts/Security-update toggles to verify |
| [#52](https://github.com/jtanori/solara/issues/52) | fix(db): apply migrations to hosted databases and gate deploys on schema verification | `type:bug` `area:db` `area:infra` `area:auth` `priority:p0` `status:ready` | ready — production auth returns `42P01 relation "users" does not exist`; `migrate.yml` has never run and `/api/health` only does `select 1`; triage staging + prod, migrate, then make health a schema gate |
| [#79](https://github.com/jtanori/solara/issues/79) | tracking: state-of-the-art migration + deployment pipeline and auth hardening (launch gate) | `type:chore` `area:infra` `priority:p1` `status:ready` | ready — **canonical epic**: children #52, #53–#72, #74–#78 |
| [#73](https://github.com/jtanori/solara/issues/73) | tracking: database operations and auth hardening epic (superseded by #79) | `status:ready` | superseded — first-pass epic; use #79 |
| [#53](https://github.com/jtanori/solara/issues/53) | auth: rate-limit sign-up/sign-in and make password hashing non-blocking | `type:security` `area:auth` `priority:p0` `status:ready` | in progress — serialized account budget + async scrypt + balanced backoff on `feat/53-54-56-57-auth-security-hardening`; staging verification pending |
| [#54](https://github.com/jtanori/solara/issues/54) | auth: add email transport and email verification | `type:feature` `area:auth` `priority:p0` `status:ready` | in progress — mailbox-proof account claim, fragment tokens, `after()` delivery on `feat/53-54-56-57-auth-security-hardening`; staging delivery pending |
| [#55](https://github.com/jtanori/solara/issues/55) | auth: add password reset flow | `type:feature` `area:auth` `priority:p0` `status:blocked` | unblocked by #54 transport/token work; still needs reset endpoints |
| [#56](https://github.com/jtanori/solara/issues/56) | security: enforce strict same-origin/CSRF checks on mutating routes | `type:security` `area:auth` `priority:p1` `status:ready` | in progress — full-origin guard + `/api/:path*` matcher on `feat/53-54-56-57-auth-security-hardening` |
| [#57](https://github.com/jtanori/solara/issues/57) | security: add security headers and a Content-Security-Policy | `type:security` `area:ui` `priority:p1` `status:ready` | in progress — headers + report-only CSP on `feat/53-54-56-57-auth-security-hardening`; enforce after observation |
| [#119](https://github.com/jtanori/solara/issues/119) | ci: require exact SHA and a real migrate run for production promotion | `type:ci` `area:infra` `priority:p1` `status:ready` | ready — production gate can accept verify-only/older-SHA staging runs; split from #118 |
| [#58](https://github.com/jtanori/solara/issues/58) | auth: add TOTP MFA for owner and admin accounts | `type:security` `area:auth` `priority:p1` `status:ready` | ready — staff MFA pre-launch requirement |
| [#59](https://github.com/jtanori/solara/issues/59) | db: separate application and migration roles (least privilege) | `type:security` `area:db` `priority:p1` `status:blocked` | blocked on #52; runtime role can currently DDL |
| [#60](https://github.com/jtanori/solara/issues/60) | db: explicit pool configuration and TLS verification | `type:bug` `area:db` `priority:p1` `status:ready` | ready — no `max`/timeouts/`pool.on("error")`; `sslmode=require` semantics change in pg 9 |
| [#61](https://github.com/jtanori/solara/issues/61) | security: remove inert channel_binding guidance, add safe URL helper and secret scan | `type:security` `area:docs` `priority:p2` `status:ready` | ready — flag is a no-op in `pg`; no secret scan in CI |
| [#62](https://github.com/jtanori/solara/issues/62) | infra: configure and test database backup/restore (one recorded drill) | `type:chore` `area:infra` `priority:p1` `status:ready` | ready — **M3 (S1)**: data recoverability gates launch |
| [#63](https://github.com/jtanori/solara/issues/63) | infra: single source of truth for DATABASE_URL and an explicit preview-database policy | `type:chore` `area:infra` `priority:p1` `status:ready` | ready — **M1 (S2)**: mitigated by #90; not a launch gate |
| [#64](https://github.com/jtanori/solara/issues/64) | db: make the migration drift check work and enforce it in CI | `type:bug` `area:ci` `priority:p1` `status:blocked` | blocked on #52; `drizzle-kit check` exits 1 in this repo |
| [#65](https://github.com/jtanori/solara/issues/65) | db: add indexes for dashboard, session and audit queries | `type:chore` `area:db` `priority:p2` `status:blocked` | blocked on #52; only one non-PK index in the schema |
| [#66](https://github.com/jtanori/solara/issues/66) | db: purge expired sessions and share revocation helpers | `type:chore` `area:db` `priority:p2` `status:ready` | ready — expired sessions never deleted |
| [#67](https://github.com/jtanori/solara/issues/67) | auth: allow users to change their password | `type:feature` `area:auth` `priority:p2` `status:ready` | ready — no rotation path today |
| [#68](https://github.com/jtanori/solara/issues/68) | auth: add sign-out-everywhere and optional session list | `type:feature` `area:auth` `priority:p2` `status:ready` | ready — stolen cookie valid for 30 days |
| [#69](https://github.com/jtanori/solara/issues/69) | security: require re-authentication for destructive actions | `type:security` `area:auth` `priority:p2` `status:ready` | ready — account deletion needs only a cookie |
| [#70](https://github.com/jtanori/solara/issues/70) | ops: split liveness (/api/health) from readiness (/api/ready) | `type:feature` `area:infra` `priority:p1` `status:blocked` | blocked on #52; the durable fix for the false-green class |
| [#71](https://github.com/jtanori/solara/issues/71) | docs: make schema and readiness verification part of AGENTS.md and the PR template | `type:docs` `priority:p2` `status:blocked` | blocked on #52 + #70 |
| [#72](https://github.com/jtanori/solara/issues/72) | docs: record ADR 006 — identity, credential ownership and the Neon Auth decision | `type:docs` `priority:p1` `status:ready` | ready — do first; unblocks the auth narrative |
| [#74](https://github.com/jtanori/solara/issues/74) | ci: verify migration journal integrity (schema/DB parity, immutable applied migrations) | `type:ci` `area:db` `priority:p1` `status:ready` | ready — CI only runs `migrate`; schema drift and edited applied files go undetected |
| [#75](https://github.com/jtanori/solara/issues/75) | ci: turn migrate.yml into a gated pipeline (plan, approval, advisory lock, post-verify, audit) | `type:ci` `area:infra` `priority:p1` `status:blocked` | blocked on #52/#70; envs have `protection_rules: 0`, no plan step, no DB lock, no audit |
| [#76](https://github.com/jtanori/solara/issues/76) | infra: make deploy.sh fail-closed (pre-merge readiness, verified rollout, rollback, release records) | `type:bug` `area:infra` `priority:p1` `status:blocked` | blocked on #70; post-merge failure is a WARN/exit 0, no rollback, no tags |
| [#77](https://github.com/jtanori/solara/issues/77) | infra: add error tracking and alerts for auth failures and readiness | `type:feature` `area:infra` `priority:p1` `status:ready` | ready — zero error tracking; #52 reached us as a user screenshot |
| [#78](https://github.com/jtanori/solara/issues/78) | docs: record ADR 007 — migrations, deployments and rollback policy | `type:docs` `area:infra` `priority:p1` `status:ready` | ready — no written policy for migrations/rollback; do with #72 |
| [#80](https://github.com/jtanori/solara/pull/80) | PR: database integration audit, #52 fix plan, Neon Auth decision, ops runbook | — | open — docs only, based on `main` |
| [#81](https://github.com/jtanori/solara/issues/81) | storage: decide and implement the PDF artefact and file storage architecture | `type:feature` `area:backend` `area:infra` `priority:p1` `status:ready` | ready — **no storage layer exists**; PDFs re-render per request |
| [#82](https://github.com/jtanori/solara/issues/82) | data: retention, export and erasure policy for user PII | `type:security` `area:backend` `area:docs` `priority:p1` `status:ready` | ready — no retention, no export, `audit_logs` write-only |
| [#83](https://github.com/jtanori/solara/issues/83) | realtime: decide and implement the state-update channel | `type:feature` `area:backend` `priority:p2` `status:ready` | ready — no SSE/WS/polling decision recorded |
| [#84](https://github.com/jtanori/solara/issues/84) | security: harden /api/places (unauthenticated keyed proxy) | `type:security` `area:backend` `priority:p1` `status:ready` | ready — no origin check, no rate limit, quota theft |
| [#85](https://github.com/jtanori/solara/issues/85) | productization: legal pages, sign-up consent, SEO metadata | `type:feature` `area:ui` `area:content` `priority:p1` `status:ready` | ready — no /privacy or /terms; no robots/sitemap/OG |
| [#86](https://github.com/jtanori/solara/issues/86) | reliability: add app-router error boundaries, 404 and loading states | `type:bug` `area:ui` `priority:p2` `status:ready` | ready — no error.tsx/not-found/loading anywhere |
| [#87](https://github.com/jtanori/solara/issues/87) | security: redact PII from server logs and add structured logging | `type:security` `area:backend` `priority:p1` `status:ready` | ready — auth errors log the query params (emails) |
| [#88](https://github.com/jtanori/solara/issues/88) | security: supply-chain controls + dependency triage | `type:security` `area:infra` `priority:p1` `status:ready` | ready — actions unpinned, 12 Dependabot PRs unreviewed |
| [#89](https://github.com/jtanori/solara/issues/89) | governance: CODEOWNERS, required approvals and branch hygiene | `type:chore` `area:infra` `priority:p1` `status:ready` | ready — both rulesets allow 0 approvals, no CODEOWNERS |
| [#90](https://github.com/jtanori/solara/issues/90) | security: secret inventory, target assignment and rotation policy | `type:security` `area:infra` `priority:p1` `status:ready` | ready — no inventory/rotation; matrix in the audit §9.2 |
| [#91](https://github.com/jtanori/solara/issues/91) | quality: validate environment configuration at boot | `type:bug` `area:backend` `priority:p2` `status:ready` | ready — no env schema; staging values can reach prod |
| [#92](https://github.com/jtanori/solara/issues/92) | quality: e2e smoke journey, coverage floor, performance budgets | `type:test` `area:infra` `priority:p2` `status:ready` | ready — no e2e; #52 class undetectable by tests |
| [#93](https://github.com/jtanori/solara/issues/93) | db: remove users.plan as a source of entitlement | `type:refactor` `area:db` `priority:p3` `status:ready` | ready — dead column decides PDF entitlement (real bug) |
| [#94](https://github.com/jtanori/solara/issues/94) | ops: incident response runbook, kill-switches, status communication | `type:docs` `area:infra` `priority:p2` `status:ready` | ready — **M1 (S2)**: #52 had no timeline, no detection, no comms |
| [#95](https://github.com/jtanori/solara/pull/95) | docs: database + deep audits, fix plans, Neon Auth decision, ops runbook, 42 issues indexed (#95) | — | merged — `staging:7fa372b` |
| [#96](https://github.com/jtanori/solara/pull/96) | chore(process): add land-audit-docs.sh guardrails script (#96) | — | merged — `staging:7b0450b` |
| [#97](https://github.com/jtanori/solara/pull/97) | feat(db): migrate through GitHub Environment secrets, with verification (#97) | — | merged — `staging:e5eebcb`; staging DB provisioned, #52 closed |
| [#98](https://github.com/jtanori/solara/pull/98) | docs(audit): readings engine assessment + epic design (#98) | — | merged — `staging:dc815ef` |
| [#99](https://github.com/jtanori/solara/issues/99) | epic: the reading document — full solar-revolution interpretation | `type:feature` `area:astro` `area:content` `priority:p1` `status:ready` | ready — epic; design in `docs/plan-readings-engine-epic.md` |
| [#100](https://github.com/jtanori/solara/issues/100) | readings: domain model + chart digest types | `type:feature` `area:backend` `area:astro` `priority:p1` `status:ready` | in progress — types + digest landed in the chart v2 PR |
| [#101](https://github.com/jtanori/solara/issues/101) | engine: chart v2 — ten bodies, houses, MC, aspects, nodes, cross-aspects | `type:feature` `area:astro` `area:backend` `priority:p1` `status:ready` | in progress — ASC/MC/whole-sign pinned against Swiss Ephemeris; 66° product cutoff regression-tested; Placidus, modality balance and correct cross-aspects are still open |
| [#117](https://github.com/jtanori/solara/issues/117) | engine: cross-aspects compare differences of differences — false positives | `type:bug` `area:astro` `area:backend` `priority:p1` `status:ready` | ready — 2457 reported vs 40 true pairwise under the configured orbs on the baseline; feeds every reading's cross-chart claims (#99) |
| [#103](https://github.com/jtanori/solara/issues/103) | readings: generation pipeline (prompt registry, schema validation, cache, freeze) | `type:feature` `area:backend` `area:content` `priority:p1` `status:ready` | ready — no LLM dependency exists yet |
| [#104](https://github.com/jtanori/solara/issues/104) | readings: free-tier sections and locked teasers | `type:feature` `area:content` `area:ui` `priority:p1` `status:ready` | ready — free = overview + sun; needs `closingQuestion` field |
| [#105](https://github.com/jtanori/solara/issues/105) | readings: consent capture and privacy copy for AI generation | `type:security` `area:auth` `area:docs` `priority:p0` `status:ready` | ready — digest is PII-free and test-asserted; consent not built |
| [#106](https://github.com/jtanori/solara/issues/106) | readings: renderer for page and PDF | `type:feature` `area:ui` `area:backend` `priority:p2` `status:ready` | ready — PDF in scope at launch |
| [#107](https://github.com/jtanori/solara/issues/107) | billing: generate paid sections on entitlement | `type:feature` `area:billing` `area:backend` `priority:p1` `status:ready` | ready — paid means not computed; Placidus recompute on purchase |
| [#108](https://github.com/jtanori/solara/issues/108) | readings: cost guards, per-reading budget ceiling and kill switch | `type:feature` `area:infra` `area:backend` `priority:p1` `status:ready` | ready — ceilings 5 MXN free / 10 MXN paid |
| [#109](https://github.com/jtanori/solara/issues/109) | readings: eval harness and astrologer review gate | `type:test` `area:content` `area:astro` `priority:p1` `status:ready` | ready — no corpus, no review gate |
| [#110](https://github.com/jtanori/solara/issues/110) | engine: profections and transits | `type:feature` `area:astro` `priority:p2` `status:ready` | ready — paid-tier layer |
| [#111](https://github.com/jtanori/solara/issues/111) | readings: astrologer review and override tooling | `type:feature` `area:content` `area:ui` `priority:p3` `status:ready` | ready — deliberately not a CMS |
| [#10](https://github.com/jtanori/solara/issues/10) | chore: validate Stripe test-mode subscription lifecycle | `type:chore` `area:billing,area:infra` `priority:p2` `status:ready` | ready — unblocked by #9; needs Stripe test keys + CLI login (Checkout → webhook → portal/renewal/cancel) |
| [#16](https://github.com/jtanori/solara/issues/16) | chore: define independent platform validation checklist | `type:chore` `area:infra,area:content,area:astro` `priority:p3` `status:needs-triage` | needs-triage — astro fixtures, hist TZ/leap/high-lat, editorial versioning, backup/restore, MFA/rate-limit/CSRF |

## Closed (recent)

| # | Title | Closed in |
|---|-------|-----------|
| [#1](https://github.com/jtanori/solara/issues/1) | chore: establish feature -> staging -> main branching and merge policy | #46 (`03467bd` merge `promo/staging-sync-20251107` 9553ceb — `staging@7c73a11`) + #47 (`9a57fab` sync) — staging exists, protect-staging (linear) / protect-main (merge), `{true,true,false,true}` squash+merge, demo #44→staging→main |
| [#2](https://github.com/jtanori/solara/issues/2) | chore: set up staging and production deployment strategy | #46 (`03467bd`) + #47 (`9a57fab`) — Vercel `solara-stg`/`solara-production` health `{"ok":true}`, Neon pooled/direct, secrets per env, `migrate.yml` + `deploy.sh` pre-merge race-free, runbooks in `01-foundation`/`00-manual-setup-ui` |
| [#3](https://github.com/jtanori/solara/issues/3) | docs: add AGENTS.md operating guide | #40 (`86c63d4`→`fc2a122`) + #44 (`7c73a11`) — AGENTS.md live, aligned to ADR 001/004 post-sync |
| [#4](https://github.com/jtanori/solara/issues/4) | docs: add decision log and pull request template | #23 (`2176a15`) promotion — implemented in #19 (`0e40608`) |
| [#5](https://github.com/jtanori/solara/issues/5) | chore: add offline BACKLOG.md index | #23 (`2176a15`) — implemented in #18 (`58aaf0e`) |
| [#8](https://github.com/jtanori/solara/issues/8) | feat: add local role seed scaffold | #23 (`2176a15`) — implemented in #19 (`0e40608`) |
| [#9](https://github.com/jtanori/solara/issues/9) | feat: add local subscription-state fixtures | #23 (`2176a15`) — implemented in #20 (`fb8408c` + `dcc6189` + `fe0e577`) |
| [#13](https://github.com/jtanori/solara/issues/13) | feat: scope /usage-guide to signed-in user role outside dev | #23 (`2176a15`) — implemented in #18 (`ea17fc2`) |
| [#14](https://github.com/jtanori/solara/issues/14) | chore: hide internal-document links and update docs outside dev | #23 (`2176a15`) — implemented in #19 (`0e40608` + `320baeb`) |
| [#15](https://github.com/jtanori/solara/issues/15) | test: verify internal-document gating in production mode | #23 (`2176a15`) — implemented in #20 (`fb8408c`) + #22 (`2176a15`) verifier passes `1m38s` |
| [#102](https://github.com/jtanori/solara/issues/102) | engine: fixture charts verified against a trusted ephemeris | #113 (`2a0ebc2`) — ten bodies + true node within 0.05° of Swiss Ephemeris; #115 follow-up added the angles, whole-sign cusps, the polar-latitude omission, the 66° cutoff policy probes and a baseline end-to-end wrapper anchor |
| [#7](https://github.com/jtanori/solara/issues/7) | refactor: extract password hashing helpers | #17 (`166539f`) |
| [#11](https://github.com/jtanori/solara/issues/11) | feat: add internal-document access resolver and tests | #17 (`166539f`) |
| [#12](https://github.com/jtanori/solara/issues/12) | feat: gate /blueprint and /setup behind development mode | #17 (`166539f`) |

## Closed (historical)

| # | Title | Closed in |
|---|-------|-----------|
| [#17](https://github.com/jtanori/solara/pull/17) | refactor+feat: password helpers, internal-document resolver, gate blueprint/setup | `166539f` |
| [#18](https://github.com/jtanori/solara/pull/18) | feat+docs: scope usage-guide to role, branching policy, backlog index (#13, #1, #5) | `5f3f19f` → `staging:1db0281` |
| [#19](https://github.com/jtanori/solara/pull/19) | feat: hide internal-doc links, PR template, local seed (#14, #4, #8) | `0e40608` → `staging:16994e4` |
| [#20](https://github.com/jtanori/solara/pull/20) | feat: subscription fixtures, prod gating verification, dependabot (#9, #15, #6) | `fb8408c` → `staging:51a4bb4` |
| [#22](https://github.com/jtanori/solara/pull/22) | fix: allow verifier in CI disposable DB (ALLOW_LOCAL_SEED_IN_CI) | `2176a15` → `staging:dfec9b6` |
| [#23](https://github.com/jtanori/solara/pull/23) | chore: promote staging to main (branching, docs, seed, gating, dependabot) | `2176a15` |
| [#36](https://github.com/jtanori/solara/pull/36) | docs: refresh BACKLOG after promotion, clarify promotion merge policy (ADR 004) | `e779bec` |
| [#41](https://github.com/jtanori/solara/issues/41) | feat(check): add --env filter to setup verifiers | `a0454ed` |
| [#42](https://github.com/jtanori/solara/pull/42) | chore: promote staging to main (AGENTS + Vercel bootstrap, --env verifiers) | `039d9b6` |
| [#43](https://github.com/jtanori/solara/pull/43) | feat(deploy): Vercel domains + migrate/deploy automation, remove vercel-bootstrap | `eb39c26` |
| [#44](https://github.com/jtanori/solara/pull/44) | feat(deploy): align promotion to merge commit, enable production deploy path | `7c73a11` |
| [#46](https://github.com/jtanori/solara/pull/46) | chore: promote staging to main — sync unrelated histories (7c73a11) | `03467bd` (merge) |
| [#47](https://github.com/jtanori/solara/pull/47) | chore: sync staging to main (03467bd) | `9a57fab` |

## How to use

- To add work: create a GitHub Issue first, then add a row here with a link.
- To close work: close the GitHub Issue, then move the row to the appropriate “Closed” table with the closing PR/commit.
- Never treat this file as the assignment source — always open the linked issue for acceptance criteria.

*17 entries added 2026-11-08 (readings epic and the migrations/audit PRs).*

*This index is intentionally minimal — it does not duplicate labels beyond a snapshot, assignees, or milestones. All lifecycle state lives in GitHub.*
