# Backlog — Solara

> **Source of truth:** [GitHub Issues](https://github.com/jtanori/solara/issues) are authoritative. This file is an **offline index** only — it lists every issue with a link and a snapshot of its lifecycle at the time of the last update. Update this file only when issues are created, changed, or closed; do not duplicate status tracking here. See `docs/decisions.md` ADR 002 and `AGENTS.md` (when it lands in #3).

*Last updated: 2026-11-07 from `main` at `2176a15` (PR #23 promotion `staging@dfec9b6 → main`).*

## Open

| # | Title | Labels | Status |
|---|-------|--------|--------|
| [#1](https://github.com/jtanori/solara/issues/1) | chore: establish feature -> staging -> main branching and merge policy | `type:chore` `area:docs,area:infra` `priority:p1` `status:ready` | ready — staging exists, `feature → staging → main` demonstrated in #23; protection/rulesets + squash-only settings still manual (see ADR 001) |
| [#2](https://github.com/jtanori/solara/issues/2) | chore: set up staging and production deployment strategy | `type:chore` `area:db,area:docs,area:infra` `priority:p1` `status:ready` | ready — Vercel/Neon isolation, domains, secrets, runbooks still to configure |
| [#3](https://github.com/jtanori/solara/issues/3) | docs: add AGENTS.md operating guide | `type:docs` `area:docs` `priority:p1` `status:blocked` | blocked → #1, #2 |
| [#6](https://github.com/jtanori/solara/issues/6) | chore: enable Dependabot alerts and security updates | `type:deps` `area:infra` `priority:p2` `status:ready` | ready — `dependabot.yml` landed in #23 (`target-branch: staging`); first update run + repo alerts/security-updates toggles still to verify |
| [#10](https://github.com/jtanori/solara/issues/10) | chore: validate Stripe test-mode subscription lifecycle | `type:chore` `area:billing,area:infra` `priority:p2` `status:blocked` | blocked → #9 (now closed); needs Stripe CLI + test keys |
| [#16](https://github.com/jtanori/solara/issues/16) | chore: define independent platform validation checklist | `type:chore` `area:infra,area:content,area:astro` `priority:p3` `status:needs-triage` | needs-triage |

## Closed (recent)

| # | Title | Closed in |
|---|-------|-----------|
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

## How to use

- To add work: create a GitHub Issue first, then add a row here with a link.
- To close work: close the GitHub Issue, then move the row to the appropriate “Closed” table with the closing PR/commit.
- Never treat this file as the assignment source — always open the linked issue for acceptance criteria.

*This index is intentionally minimal — it does not duplicate labels beyond a snapshot, assignees, or milestones. All lifecycle state lives in GitHub.*
