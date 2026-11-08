# Backlog — Solara

> **Source of truth:** [GitHub Issues](https://github.com/jtanori/solara/issues) are authoritative. This file is an **offline index** only — it lists every issue with a link and a snapshot of its lifecycle at the time of the last update. Update this file only when issues are created, changed, or closed; do not duplicate status tracking here. See `docs/decisions.md` ADR 002 and `AGENTS.md`.

*Last updated: 2026-11-08 from `staging` at `4490ced` — #52 incident filed, then 21 follow-up issues (#53–#73) planned from `docs/audit-database-integration.md` and `docs/plan-neon-auth-migration.md`.*

## Open

| # | Title | Labels | Status |
|---|-------|--------|--------|
| [#6](https://github.com/jtanori/solara/issues/6) | chore: enable Dependabot alerts and security updates | `type:deps` `area:infra` `priority:p2` `status:ready` | ready — `dependabot.yml` `target-branch: staging` landed in #23; first update run + repo Alerts/Security-update toggles to verify |
| [#52](https://github.com/jtanori/solara/issues/52) | fix(db): apply migrations to hosted databases and gate deploys on schema verification | `type:bug` `area:db` `area:infra` `area:auth` `priority:p0` `status:ready` | ready — production auth returns `42P01 relation "users" does not exist`; `migrate.yml` has never run and `/api/health` only does `select 1`; triage staging + prod, migrate, then make health a schema gate |
| [#73](https://github.com/jtanori/solara/issues/73) | tracking: database operations and auth hardening epic (launch gate) | `status:ready` | ready — epic index with execution order + launch gate; children #52, #53–#72 |
| [#53](https://github.com/jtanori/solara/issues/53) | auth: rate-limit sign-up/sign-in and make password hashing non-blocking | `type:security` `area:auth` `priority:p0` `status:ready` | ready — **launch blocker**; no limiter today, `scryptSync` blocks the event loop |
| [#54](https://github.com/jtanori/solara/issues/54) | auth: add email transport and email verification | `type:feature` `area:auth` `priority:p0` `status:ready` | ready — **launch blocker**; no mail transport exists at all |
| [#55](https://github.com/jtanori/solara/issues/55) | auth: add password reset flow | `type:feature` `area:auth` `priority:p0` `status:blocked` | blocked on #54 (transport + token table); **launch blocker** |
| [#56](https://github.com/jtanori/solara/issues/56) | security: enforce strict same-origin/CSRF checks on mutating routes | `type:security` `area:auth` `priority:p1` `status:ready` | ready — `sameOrigin()` returns true when `Origin` is absent; **launch blocker** |
| [#57](https://github.com/jtanori/solara/issues/57) | security: add security headers and a Content-Security-Policy | `type:security` `area:ui` `priority:p1` `status:ready` | ready — zero security headers today; **launch blocker** |
| [#58](https://github.com/jtanori/solara/issues/58) | auth: add TOTP MFA for owner and admin accounts | `type:security` `area:auth` `priority:p1` `status:ready` | ready — staff MFA pre-launch requirement |
| [#59](https://github.com/jtanori/solara/issues/59) | db: separate application and migration roles (least privilege) | `type:security` `area:db` `priority:p1` `status:blocked` | blocked on #52; runtime role can currently DDL |
| [#60](https://github.com/jtanori/solara/issues/60) | db: explicit pool configuration and TLS verification | `type:bug` `area:db` `priority:p1` `status:ready` | ready — no `max`/timeouts/`pool.on("error")`; `sslmode=require` semantics change in pg 9 |
| [#61](https://github.com/jtanori/solara/issues/61) | security: remove inert channel_binding guidance, add safe URL helper and secret scan | `type:security` `area:docs` `priority:p2` `status:ready` | ready — flag is a no-op in `pg`; no secret scan in CI |
| [#62](https://github.com/jtanori/solara/issues/62) | infra: configure and test database backup/restore (one recorded drill) | `type:chore` `area:infra` `priority:p1` `status:ready` | ready — no backup/PITR/restore evidence anywhere |
| [#63](https://github.com/jtanori/solara/issues/63) | infra: single source of truth for DATABASE_URL and an explicit preview-database policy | `type:chore` `area:infra` `priority:p1` `status:ready` | ready — Vercel and GitHub Environments hold the same secret, never compared |
| [#64](https://github.com/jtanori/solara/issues/64) | db: make the migration drift check work and enforce it in CI | `type:bug` `area:ci` `priority:p1` `status:blocked` | blocked on #52; `drizzle-kit check` exits 1 in this repo |
| [#65](https://github.com/jtanori/solara/issues/65) | db: add indexes for dashboard, session and audit queries | `type:chore` `area:db` `priority:p2` `status:blocked` | blocked on #52; only one non-PK index in the schema |
| [#66](https://github.com/jtanori/solara/issues/66) | db: purge expired sessions and share revocation helpers | `type:chore` `area:db` `priority:p2` `status:ready` | ready — expired sessions never deleted |
| [#67](https://github.com/jtanori/solara/issues/67) | auth: allow users to change their password | `type:feature` `area:auth` `priority:p2` `status:ready` | ready — no rotation path today |
| [#68](https://github.com/jtanori/solara/issues/68) | auth: add sign-out-everywhere and optional session list | `type:feature` `area:auth` `priority:p2` `status:ready` | ready — stolen cookie valid for 30 days |
| [#69](https://github.com/jtanori/solara/issues/69) | security: require re-authentication for destructive actions | `type:security` `area:auth` `priority:p2` `status:ready` | ready — account deletion needs only a cookie |
| [#70](https://github.com/jtanori/solara/issues/70) | ops: split liveness (/api/health) from readiness (/api/ready) | `type:feature` `area:infra` `priority:p1` `status:blocked` | blocked on #52; the durable fix for the false-green class |
| [#71](https://github.com/jtanori/solara/issues/71) | docs: make schema and readiness verification part of AGENTS.md and the PR template | `type:docs` `priority:p2` `status:blocked` | blocked on #52 + #70 |
| [#72](https://github.com/jtanori/solara/issues/72) | docs: record ADR 006 — identity, credential ownership and the Neon Auth decision | `type:docs` `priority:p1` `status:ready` | ready — do first; unblocks the auth narrative |
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

*This index is intentionally minimal — it does not duplicate labels beyond a snapshot, assignees, or milestones. All lifecycle state lives in GitHub.*
