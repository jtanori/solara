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
**Status:** ~~Accepted~~ **Superseded by ADR 009** (2026-11-10, #132) — the file was removed  
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

## ADR 006 — Identity and credential ownership: keep local auth for launch

**Date:** 2026-11-10
**Status:** Accepted
**Issue:** #72

### Context
Solara currently owns password credentials, verification tokens, sessions, and password reset locally. Neon Auth is available as a managed alternative, but adopting it changes the session model, user provisioning, email delivery, and the migration path for existing accounts. The identity decision is a launch prerequisite under ADR 003 and must not be made implicitly by adding a second auth system.

### Decision
- Keep the current local auth implementation through launch. Do not add Neon Auth at launch.
- Local auth remains security-critical: password hashing, account claim, email verification, password reset, session revocation, throttling, and audit logging stay behind the existing server-side checks (ADR 007).
- Revisit Neon Auth only when a trigger below is met and the security review below is recorded:
  - staff MFA, SSO/SAML, passkeys, or organization/team accounts become a launch requirement;
  - credential operations become a material operational burden;
  - another application needs shared identity;
  - the local auth implementation cannot meet an agreed security or availability requirement.
- Any future migration must preserve:
  - mailbox proof and single-use, hashed, expiring tokens;
  - server-side session issuance and revocation;
  - password reset audit rows and rate limits;
  - the `user`/`editor`/`admin`/`owner` role boundary;
  - no implicit account linking by email, and no login based on unverified provider email.
- The Neon Auth migration plan must define `auth_provider` data, ambient-auth disablement, JWT cookie and proxy verification, trigger/introspection behavior, canonical HTTPS, password reset mail, user-id mapping, dual-read/rollback, and a tested account-linking path. See `docs/plan-neon-auth-migration.md`.
- Review this decision by **2027-02-10** or earlier if a trigger is met. A change requires a superseding ADR and a security review, not a configuration toggle.

### Consequences
- The local auth surface remains in scope for dependency, threat-model, and penetration-test reviews.
- Neon Auth cannot be introduced as a parallel login path; doing so would violate the single-issuer session invariant.
- The existing #53/#54/#55/#56/#57 controls remain the launch baseline.

---

## ADR 007 — Auth and transport hardening for launch

**Date:** 2026-11-09
**Status:** Accepted
**Issues:** #53, #54, #56, #57

### Context
The prototype had unlimited auth attempts, synchronous scrypt, no email channel, a same-origin check that accepted a missing `Origin`, and no security headers or CSP. These are launch blockers under the ADR 003 platform-validation gate.

### Decision
- Password hashing uses async `scrypt` so auth bursts cannot block the event loop.
- Sign-up collects name and email only. No session or usable password exists before mailbox proof. The mailbox owner claims the account by choosing a password; claim revokes all sessions and invalidates sibling tokens.
- Sign-in is unavailable until the claim completes. Per-IP and per-account attempts are serialized with transaction-scoped locks in IP → account order; the counters, password check, and session creation share that transaction. Ten account failures trigger progressive 30s-to-15m backoff; IP ceilings are 100 all-attempts and 50 failures per 15m. Scrypt is capped at four concurrent operations with a bounded queue; saturation returns a generic 503. Responses use `429` + `Retry-After` and never reveal whether an email exists.
- Email delivery runs in `after()` so provider latency does not reveal account existence. Tokens are hashed at rest and never stored in queues or logs. The previous token stays valid until a new message is delivered; ambiguous outcomes keep both tokens; finalization is generation-aware and uses the same user → token lock order as claim; claim invalidates siblings and refuses verified accounts. A post-send finalization failure keeps the delivered token.
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

## ADR 008 — One migration path, deploy order and rollback

**Date:** 2026-11-10
**Status:** Accepted
**Issue:** #78

### Context
The #52 incident came from ad-hoc migration work and database state that did not match the committed journal. Multiple ways to apply DDL (local shell, `drizzle-kit push`, manual SQL, a deploy hook) make the target ambiguous and the rollback story untestable. Production also needs a clear statement of what is reversible: code is, schema history is not.

### Decision
- **One migration path:** generate with `npx drizzle-kit generate --name=...`, review the SQL and `drizzle/meta`, then apply through `scripts/db-run.ts --env <env> migrate` locally or `.github/workflows/migrate.yml` for hosted environments. `drizzle-kit push` is forbidden on staging and production. No boot-time DDL and no manual schema edits.
- **One reviewed migration per PR.** The migration SQL, journal, snapshot, and runtime manifest are committed together. Applied migrations are immutable: correcting one requires a new forward migration, never editing history.
- **Expand/contract for breaking changes.** Add nullable columns/tables first, deploy compatible code, backfill in a separate reviewed step, then remove old structures after the previous release is no longer running.
- **Destructive changes require explicit review.** Dropping/renaming a table or column, narrowing a type, or rewriting data must be named in the PR body with a backup/restore and rollback note.
- **Migrate before deploy.** Hosted migrations run before the code that requires them. The new code must tolerate the previous schema for one rollout; a migration must not depend on the new code being live.
- **Rollback:** code can be rolled back when it is compatible with the migrated schema. Schema rollback is a forward fix or a Neon point-in-time restore, not a down migration. Restore drills are part of ADR 003.
- **Ownership:** the operator who approves the PR owns the migration and its verification. `staging` runs first for every schema change; `production` runs only after a green exact-SHA staging rehearsal (ADR 007 / #120).
- **Environment map:** local uses a disposable loopback database; staging uses `solara-staging`; production uses `solara-prod`. Secrets live in the matching GitHub Environment and Vercel environment, never in the repository.
- **Verification:** CI runs `db:manifest:check`, migrations, and `db:check`. `scripts/deploy.sh` runs a read-only hosted `db-remote --check` against the reviewed ref before merge and requires `/api/ready` after merge. A stale manifest, pending migration, unexpected applied hash, or missing table/index is a hard failure.
- **Good migration PR:** one logical change, reviewed SQL, a test that would fail without the migration, an explicit risk/rollback section, and evidence from a fresh database plus staging.

### Consequences
- A schema change cannot bypass the journal or the manifest.
- Rollback expectations are honest: restore or forward fix, not a down-migration.
- Any new migration must update `src/lib/migration-manifest.ts` and pass `npm run db:check`.
- The #52 failure mode (database ahead/behind the journal) is now detected before merge and reflected in `/api/ready`.

---

*This file is the canonical rationale; update it when a decision changes and link to the superseding PR.*

---

## ADR 009 — No committed backlog file; the snapshot is generated on demand

**Date:** 2026-11-10
**Status:** Accepted
**Issue:** #132 (supersedes ADR 002)

### Context
ADR 002 declared `BACKLOG.md` "an index, not a source of truth" and asked that it be updated whenever
issues were created, changed or closed. Nothing enforced that, so the file drifted. Measured against
the GitHub API on 2026-11-10, after a single promotion cycle's worth of label changes:

- 94 rows carried hand-written label text; **42 matched** GitHub and **11 had drifted**;
- **two open issues were missing entirely** (#128, #129);
- **at least six rows described already-closed issues** (#16, #52, #101, #102, #117, #73);
- drift ran in both directions — #10 showed `status:ready` while GitHub said `status:blocked`.

The cost is not the editing time. It is that agents and contributors *read* the file as current, so a
stale row becomes a stale decision. A document that must be hand-synchronised with a system that
changes several times a day will be wrong most of the time, and "not a source of truth" in a README
does not stop a reader trusting it.

### Decision
- **No backlog file is tracked in the repository.** `BACKLOG.md` is deleted.
- `npm run backlog:snapshot` (`scripts/backlog-snapshot.ts`) renders an offline snapshot from the
  GitHub API to `docs/backlog-snapshot.md`, which is **`.gitignore`d**.
- The snapshot header always records the **generation timestamp**, the **repository**, the **git SHA**
  it was produced at, and the **exact query**, so a reader judges freshness instead of assuming it.
- Offline access is served by generating the snapshot *before* going offline. A stale copy therefore
  cannot exist in the repository — staleness is impossible, not merely discouraged.
- The generator **fails loudly** (non-zero, no partial file) when `gh` is missing, unauthenticated, or
  returns unexpected output. A snapshot that silently rendered an empty table would be worse than no
  snapshot.
- Generating in CI and committing the output was considered and rejected: it keeps the file but
  re-creates a commit-per-issue-change treadmill and a merge-conflict magnet on nearly every
  concurrent PR.

### Consequences
- GitHub Issues are the only place issue lifecycle lives. There is no second copy to contradict.
- A contributor who never runs the generator is never blocked and never reads stale state as fact.
- Offline planning requires one command beforehand, which is the intended trade.
- CI does not check the snapshot, because it is not in the tree; nothing can go stale silently.
- ADR 002's text is retained unchanged (append-only); its status now points here.
