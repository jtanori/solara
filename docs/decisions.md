# Decision Log — Solara

This document records durable product and process decisions as Architecture Decision Records (ADRs). GitHub issues are the execution tracker; this file is the rationale.

---

## ADR 001 — Branching model: `feature → staging → main`

**Date:** 2026-11-07  
**Status:** Accepted  
**Issue:** #1  

### Context
We need environment isolation for a prototype that will handle personal data and billing. A single Vercel project with branch-based Preview deployments can separate staging and production, but only if branches are long-lived, protected, and have a clear promotion path.

### Decision
- **`staging`** is a long-lived branch from `main` at `166539f`. Feature work branches from `staging` as `<type>/<issue-number>-<slug>` (e.g. `feat/13-usage-guide-role-scope`).
- Merge flow: `feature → staging` (reviewed PR) → QA on staging → promotion PR `staging → main` → Vercel production deploy.
- **Merge settings:** squash-only, auto-delete head branches on the repository (Settings → General → Pull Requests). Verified via `gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'` should be `{true,false,false,true}` — currently requires manual toggle (403 for `GITHUB_TOKEN` on API).
- **Branch protection — `staging` (target, not yet applied):**
  - Require PR before merging
  - Require status check `verify` (CI: migrations, typecheck, lint, tests, audit, build + smoke)
  - Require conversation resolution
  - Require linear history
  - Block force-pushes and deletions
  - Required approvals: **0** while single collaborator (target: enforced via Ruleset “Require a pull request before merging” with `required_approving_review_count: 0`; **Status: not applied yet** — `gh api repos/jtanori/solara/rulesets` → `[]`, no rulesets)
- **Branch protection — `main` (target, not yet applied):**
  - Same as `staging`, plus required approvals deferred to `1` once a second maintainer exists (per #1 spec). Today `0` — self-merge is allowed; `gh pr review --approve` from author is blocked by GitHub (expected). **Status: not applied yet**.
- **Documentation:** `docs/setup/01-foundation-and-deployment.md` is kept aligned with the above.

### Consequences
- Every change is reviewed, CI-gated, and promoted through staging before production.
- The first PR under this model is `arena/7e0b46ac-solara` demonstrating `feature → staging → main`.

---

## ADR 002 — Offline `BACKLOG.md` is an index, not a source of truth

**Date:** 2026-11-07  
**Status:** Accepted  
**Issue:** #5  

### Context
GitHub Issues are the backlog, but offline/plane access is useful.

### Decision
- `BACKLOG.md` at the repo root lists every issue with a link (`#<n>`) and lifecycle (`open/closed`, `p1/p2/p3`, `ready/blocked`).
- **GitHub Issues are authoritative.** `BACKLOG.md` is updated only when issues are created, changed, or closed.
- `AGENTS.md` references `BACKLOG.md` to point contributors/agents to the index.

### Consequences
- No duplicate status tracking; links must resolve.

---

## ADR 003 — Platform-validation checklist is a pre-launch gate

**Date:** 2026-11-07  
**Status:** Accepted  
**Issue:** #16  

### Context
Solar-return calculations use `astronomy-engine` and whole-sign houses; historical time zones, high latitudes, leap years, and editorial content require independent professional validation.

### Decision
- Define a checklist covering: astronomical fixtures, historical zones/leap years/high latitudes, editorial/professional review + report versioning, backup/restore drills + monitoring/incident response, and remaining security/privacy controls (email verification, password recovery, staff MFA, rate limiting, CSRF, retention/export).
- Checklist items have owners and evidence requirements; launch gate is documented in `docs/setup/README.md` and `README.md`.
- No production launch with real customer data or live billing until checklist is complete.

### Consequences
- Build passing or `check-setup.mjs` success is not launch approval.

---

## ADR 004 — COMMENT-only reviews and squash merge

**Date:** 2026-11-07  
**Status:** Accepted  
**Issues:** #1, #4  

### Context
With a single collaborator, requiring approving reviews blocks progress, but unreviewed merges risk quality.

### Decision
- Every PR is reviewed via GitHub **Commented** reviews (not Approvals) until a second maintainer exists; the author cannot approve own PRs (GitHub-enforced).
- Target: branch protection will require **conversation resolution** — open review comments must be resolved before merge. **Status: not applied yet** (no rulesets).
- Merge method is **squash** only, preserving a linear history and a single commit per feature on `main`/`staging`. **Status: target** — repo currently `allow_merge_commit:true`, `allow_rebase_merge:true`, `delete_branch_on_merge:false`; verify with `gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'` and toggle in Settings → General → Pull Requests.

### Consequences
- Human-readable review history is kept in PR comments; `mergeStateStatus` must be `CLEAN` and `verify` green.

---

## ADR 005 — Prototype gate — not production-ready

**Date:** 2026-11-07  
**Status:** Accepted  
**Issue:** #16 (platform-validation checklist)

### Context
Launch limitations are listed in `README.md` and `docs/setup/README.md`: calculations need independent validation; email verification, password recovery, MFA, rate limiting, full CSRF, etc. are outstanding.

### Decision
- The app ships as a functional prototype. Public sign-up creates a free `user`; owner provisioning is via a privileged `psql` session, not a bootstrap endpoint.
- No Stripe live keys, real customer data, or production secrets are committed or used in Preview deployments.
- Target: branch protection and per-environment isolation (separate DBs/keys, #2) will enforce this once applied.

### Consequences
- Any production deploy must pass ADR 003 checklist and the operational runbook in `docs/setup/01-foundation-and-deployment.md`.

---

*This file is the canonical rationale; update it when a decision changes and link to the superseding PR.*
