# Backlog — Solara

> **Source of truth:** [GitHub Issues](https://github.com/jtanori/solara/issues) are authoritative. This file is an **offline index** only — it lists every issue with a link and a snapshot of its lifecycle at the time of the last update. Update this file only when issues are created, changed, or closed; do not duplicate status tracking here. See `docs/decisions.md` ADR 002 and `AGENTS.md` (when it lands in #3).

*Last updated: 2026-11-07 from `main` at `166539f` (16 issues + PR #17).*

## Open

| # | Title | Labels | Status |
|---|-------|--------|--------|
| [#1](https://github.com/jtanori/solara/issues/1) | chore: establish feature -> staging -> main branching and merge policy | `type:chore` `area:docs,area:infra` `priority:p1` `status:ready` | ready |
| [#2](https://github.com/jtanori/solara/issues/2) | chore: set up staging and production deployment strategy | `type:chore` `area:db,area:docs,area:infra` `priority:p1` `status:ready` | ready |
| [#3](https://github.com/jtanori/solara/issues/3) | docs: add AGENTS.md operating guide | `type:docs` `area:docs` `priority:p1` `status:blocked` | blocked → #1, #2 |
| [#4](https://github.com/jtanori/solara/issues/4) | docs: add decision log and pull request template | `type:docs` `area:docs` `priority:p1` `status:blocked` | blocked → #1 |
| [#5](https://github.com/jtanori/solara/issues/5) | chore: add offline BACKLOG.md index | `type:docs` `area:docs` `priority:p2` `status:ready` | ready (this file) |
| [#6](https://github.com/jtanori/solara/issues/6) | chore: enable Dependabot alerts and security updates | `type:deps` `area:infra` `priority:p2` `status:ready` | ready |
| [#8](https://github.com/jtanori/solara/issues/8) | feat: add local role seed scaffold | `type:feature` `area:db,area:docs,area:infra` `priority:p2` `status:blocked` | blocked → #7 (now closed) |
| [#9](https://github.com/jtanori/solara/issues/9) | feat: add local subscription-state fixtures | `type:feature` `area:db,area:billing` `priority:p2` `status:blocked` | blocked → #8 |
| [#10](https://github.com/jtanori/solara/issues/10) | chore: validate Stripe test-mode subscription lifecycle | `type:chore` `area:billing,area:infra` `priority:p2` `status:blocked` | blocked → #9 |
| [#13](https://github.com/jtanori/solara/issues/13) | feat: scope /usage-guide to signed-in user role outside dev | `type:security` `area:ui,area:backend,area:auth` `priority:p1` `status:blocked` | blocked → #11 (now closed) |
| [#14](https://github.com/jtanori/solara/issues/14) | chore: hide internal-document links and update docs outside dev | `type:chore` `area:ui,area:docs` `priority:p1` `status:blocked` | blocked → #12, #13 |
| [#15](https://github.com/jtanori/solara/issues/15) | test: verify internal-document gating in production mode | `type:test` `area:backend,area:auth,area:infra` `priority:p1` `status:blocked` | blocked → #12, #13, #14 |
| [#16](https://github.com/jtanori/solara/issues/16) | chore: define independent platform validation checklist | `type:chore` `area:infra,area:content,area:astro` `priority:p3` `status:needs-triage` | needs-triage |

## Closed (recent)

| # | Title | Closed in |
|---|-------|-----------|
| [#7](https://github.com/jtanori/solara/issues/7) | refactor: extract password hashing helpers | #17 (`166539f`) |
| [#11](https://github.com/jtanori/solara/issues/11) | feat: add internal-document access resolver and tests | #17 (`166539f`) |
| [#12](https://github.com/jtanori/solara/issues/12) | feat: gate /blueprint and /setup behind development mode | #17 (`166539f`) |
| [#17](https://github.com/jtanori/solara/pull/17) | refactor+feat: password helpers, internal-document resolver, gate blueprint/setup | `166539f` |

## Closed (historical)

*No additional historical issues at this snapshot.*

## How to use

- To add work: create a GitHub Issue first, then add a row here with a link.
- To close work: close the GitHub Issue, then move the row to the appropriate “Closed” table with the closing PR/commit.
- Never treat this file as the assignment source — always open the linked issue for acceptance criteria.

*This index is intentionally minimal — it does not duplicate labels beyond a snapshot, assignees, or milestones. All lifecycle state lives in GitHub.*
