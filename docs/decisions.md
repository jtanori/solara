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
- **Merge settings:** **squash for `feature → staging`, merge commit for `staging → main`** (ADR 004), auto-delete head branches (Settings → General → Pull Requests). Verified via `gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'` → `{true,true,false,true}` — `allow_squash_merge:true` for features, `allow_merge_commit:true` for promotions, `delete_branch_on_merge:true`.
- **Branch protection — `staging` (applied 2026-11-07 as `protect-staging`):**
  - Require PR before merging
  - Require status check `verify` (CI: migrations, typecheck, lint, tests, audit, build + smoke)
  - Require conversation resolution
  - Require linear history
  - Block force-pushes and deletions
  - Required approvals: **0** while single collaborator (enforced via Ruleset “Require a pull request before merging” with `required_approving_review_count: 0`)
- **Branch protection — `main` (applied 2026-11-07 as `protect-main`):**
  - Same as `staging` except **no linear history** (merge commits allowed for promotions), plus required approvals deferred to `1` once a second maintainer exists (per #1 spec). Today `0` — self-merge is allowed; `gh pr review --approve` from author is blocked by GitHub (expected).
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
- Branch protection requires **conversation resolution** — open review comments must be resolved before merge (enforced via `protect-staging`/`protect-main` Rulesets).
- Merge method is **squash for `feature → staging`** (one commit per feature), **merge commit for `staging → main`** (preserves ancestry so `staging` remains ancestor of `main` and future promotions diff only new work). Repo `allow_squash_merge:true` + `allow_merge_commit:true` + `delete_branch_on_merge:true` (verify via `gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'` → `{true,true,false,true}`). See PR #23 review for rationale.

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

> **ADR 006 is reserved** for #72 (identity, credential ownership and the Neon Auth decision).

## ADR 007 — Auth and transport hardening for launch

**Date:** 2026-11-09
**Status:** Accepted
**Issues:** #53, #54, #56, #57

### Context
The prototype had unlimited auth attempts, synchronous scrypt, no email channel, a same-origin check that accepted a missing `Origin`, and no security headers or CSP. These are launch blockers under the ADR 003 platform-validation gate.

### Decision
- Password hashing uses async `scrypt` so auth bursts cannot block the event loop.
- Sign-up collects name and email only. No session or usable password exists before mailbox proof. The mailbox owner claims the account by choosing a password; claim revokes all sessions and invalidates sibling tokens.
- Sign-in is unavailable until the claim completes. Per-account attempts are serialized with a PostgreSQL lock; 10 failures trigger progressive 30s-to-15m backoff. IP ceilings are generous (100 all-attempts, 50 failures per 15m). Responses use `429` + `Retry-After` and never reveal whether an email exists.
- Email delivery runs in `after()` so provider latency does not reveal account existence. Tokens are hashed at rest and never stored in queues or logs. The previous token stays valid until a new message is delivered; ambiguous outcomes keep both tokens; finalization is generation-aware; claim invalidates siblings and refuses verified accounts. A post-send finalization failure keeps the delivered token.
- `src/proxy.ts` centrally rejects cookie-authenticated mutating API requests unless the complete `Origin` (scheme, host, port) matches a trusted origin or `Sec-Fetch-Site: same-origin`. Stripe webhooks and CSP reports are exempt. There is no Bearer exemption until a real bearer flow exists.
- Migration `0002` does not backfill legacy accounts as verified, and `db-run verify` rejects a verification column with a default. It revokes unverified sessions; legacy users must claim with a new password.
- `src/lib/security-headers.ts` owns the security headers and the nonce CSP allowlist. CSP starts in `report-only` mode and moves to `enforce` only after a clean observation window.

### Consequences
- New mutating routes inherit the origin guard; do not duplicate it per route.
- New third-party origins must be added to the CSP allowlist and documented in `docs/setup/08-auth-security-hardening.md`.
- Rate-limit keys are hashed; operational inspection uses `npm run rate-limits:report`, never raw emails or IPs.
- Existing unverified users are logged out and must claim; seed fixtures are local-only and verified.
- Production promotion requires the separate exact-SHA migration-gate PR.
- #57 remains open until CSP enforcement is verified after the observation window.

---

*This file is the canonical rationale; update it when a decision changes and link to the superseding PR.*
