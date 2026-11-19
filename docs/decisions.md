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

---

## ADR 010 — Account lifecycle lease, not a session advisory lock

**Date:** 2026-11-15
**Status:** Accepted
**Issues:** #142, #144

### Context
Checkout and account deletion must be mutually exclusive per user. The v3.2 implementation used a
`pg_try_advisory_lock` held for the lifetime of a coordination connection. Neon's pooled application
URL runs in transaction mode, where acquire and work can land on different server sessions; a
session-level lock is therefore not a durable coordination primitive. The old one-argument
`pg_advisory_xact_lock(hashtext(...))` is transaction-scoped but does not conflict with the new
two-argument lock, so a cutover gap existed between old and new instances.

### Decision
- Coordination uses one `account_lifecycle_leases` row per user: `user_id` primary key, random
  `owner`, `expires_at`, `created_at`, `updated_at`; index on `expires_at`. No foreign key.
- Acquire atomically with `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now()`.
  TTL 60s, heartbeat 15s, acquire wait 5s.
- The callback and lease acquire/heartbeat/release use the app pool; lease queries are short autocommit
  statements. No app-pool transaction spans Stripe I/O.
- The final checkout/deletion transaction locks the lease row `FOR UPDATE`, then the user row, and
  fails with 503 if the owner or expiry no longer matches.
- Deletion expiry is capped at 100 sessions and 20s. After the deadline, remaining calls are
  aborted and the route waits for the in-flight call before releasing the lease. A failed or lost
  lease deletes nothing.
- `LIFECYCLE_ADVISORY_COMPAT` is off by default. Setting it to `1` holds the old one-argument
  advisory lock on the coordination pool while the lease is held, for a controlled old/new overlap.
  That compatibility transaction does span provider I/O, consumes one coordination connection per
  concurrent lifecycle operation, and should be enabled only for the cutover window. Normal
  deployments drain pre-lease instances instead.
- `0005` is additive. After it is applied, old code's `/api/ready` returns 503 because its manifest
  lacks the migration. Rollback is forward-fix or restore, not promotion of a pre-`0005` deployment.
  Preflight the preview DB before `deploy.sh` when preview readiness needs the new schema.

### Consequences
- Lease state is visible across PgBouncer sessions and instances.
- Crash recovery is automatic after TTL; a cleanup script removes expired rows.
- If the opt-in compatibility window is used, it pins one coordination connection per concurrent
  lifecycle operation across provider I/O. Its capacity is bounded by `DB_COORDINATION_POOL_MAX`;
  the default path does not use that connection.
- A migration that old code does not know makes readiness-based automatic rollback unavailable;
  operators must forward-fix.

---

## ADR 011 — Solar Return first and a shared four-product offer

**Date:** 2026-11-11

**Status:** Accepted product direction; implementation and release qualification pending

**Context:** Operator's revised development priorities and answers to the product choices

### Context
The core Solar implementation is substantial, but a decorative wheel and synthetic
LLM evidence do not constitute a completed chart product. The operator wants core
product delivery ahead of low-risk edge cases and a detailed user-system inventory
before deciding which account conveniences belong in the initial release.

### Decision
- Complete **Solar Return → payments → Free/Premium**, in that order. This supersedes
  the earlier recommendation to finish payments before Solar completion.
- Lunar Return, Natal Chart and Synastry remain pre-production requirements, but
  discussion of their detail waits until Solar is complete. Payments still precede
  those three additions; do not begin designing them as part of the Solar slice.
- Defer auth/mail acceptance testing until the other critical features are complete;
  do not confuse deferral with verified readiness or removal of launch qualification.
- Include a factual visualization in Solar completion: saved positions, houses,
  angles and aspects, consistent with the selected report and PDF. The decorative
  wheel must not be relabeled as factual. Preserve legacy snapshot/prose identity.
- The lifetime Free introduction may be used on **any one of the four products**.
  This is one account-wide offer, not a separate free offer for every product.
- Use **one Premium subscription and a larger bounded shared generation allowance**
  across products, not four subscriptions, four independent allowances or unlimited
  generation. Decide the exact quantity and product-specific Free sections in the
  Free/Premium phase after payments; they do not block Solar development.
- Require known birth times for chart subjects (both subjects for future Synastry).
  Do not implement unknown-time mode or silently supply a guessed time.
- Keep checkout pagination (#143) as the **first post-production follow-up**. Its
  earlier pre-purchase-gate wording is superseded, not evidence that it was fixed.
  Prioritize material security/privacy/money risks over low-risk scale edge cases.
- User-system launch/post-launch recommendations remain proposals until the
  operator chooses them; this decision does not approve every missing feature.

### Consequences
- [Solar completion](plan-solar-return-completion.md) defines the focused delivery
  outcome. GitHub Issues track execution; this ADR is not a duplicate backlog.
- Current Solar-only Free and one-paid-edition-per-UTC-month code remain unchanged
  until an explicit versioned implementation of the expanded offer. Preserve
  consumed allowances, unknown exposure, saved editions and immutable history.
- Explicit consent/generation, deterministic calculations, genuine provider/editorial
  evidence and truthful progress remain required. Existing tools can support content
  review without first building an editorial queue or CMS.
- Auth testing is later, not omitted. Public signup/recovery, ordinary Stripe
  lifecycle and the necessary runtime/privacy qualification still need evidence
  before accepting customers. Do not restore every stale historical blocker as a
  new feature dependency without assessing its current code and material risk.
- No provider/Stripe spending, hosted data changes, activation, deployment or
  production promotion follows automatically from this product decision.

---

## ADR 012 — Readiness tolerates schema-ahead in production

**Date:** 2026-11-19

**Status:** Accepted; implementation pending (milestone M5, `docs/plan-deployment-alignment.md`)

**Context:** Operator review of the deploy pipeline after a production readiness incident

### Context
`buildReadiness` compares the applied migration hashes in `drizzle.__drizzle_migrations` with
`EXPECTED_MIGRATIONS` as an **exact set**, and `tests/readiness.test.ts` pins that as the contract.
Two consequences were accepted as normal until now:

- Migrations are applied *before* the deployment that needs them (correct ordering), so between
  `migrate` succeeding and the new build serving, the still-live build sees hashes it does not
  know and reports `503`. The runbook calls this "expected readiness skew".
- A Vercel Instant Rollback after a migration restores availability but never restores readiness:
  the rolled-back build permanently lacks the new hash. Monitors and the next deploy stay red.

Exact equality was doing double duty: detecting "you are pointed at the wrong database" *and*
forbidding forward-compatible rollout. The first signal is worth keeping; the second is not a
property a production system can have.

### Decision
Replace equality with four states: `exact`, `ahead`, `behind`, `diverged`.

- `exact` — ok.
- `ahead` — ok. Applied is a superset of expected and every extra entry is newer than the build's
  newest expected migration.
- `behind` — fatal (expected has entries the database has not applied).
- `diverged` — fatal (applied contains an older or unknown entry).

There is **no numeric cap** on how far ahead a database may be. A fourth unknown migration is no
more dangerous than a second, and a cap adds a test matrix without adding safety. The bound is
**time**: `/api/version` reports the state continuously, and the drift monitor alerts when it is
not `exact` for longer than the observation threshold.

`/api/ready` and `/api/version` expose the state as a **string only** — never counts, tags, or
table names, consistent with the detail budget already enforced in `src/app/api/ready/handler.ts`.

### Consequences
- **This removes the last automated signal that a rollback is schema-incompatible.** A rolled-back
  build now reports green. The compensating controls are mandatory, not optional: a *blocking*
  destructive-DDL lint on every PR that adds `drizzle/*.sql`, expand/contract discipline for
  breaking changes, and persistent `ahead` reporting with time-bounded alerting. The lint must
  merge before or with this change.
- `docs/PR_WORKFLOW.md`, `docs/setup/01-foundation-and-deployment.md` and the runbooks must stop
  describing readiness skew as an expected 503, and #76's "readiness-based rollback unavailable"
  wording is superseded.
- Displaying `ahead` forever is intentional. A stuck `ahead` is the signal; a passing one is not.
- **Deployment records:** `docs/deploys.md` is frozen with a header pointing at its replacement.
  GitHub Deployments (created by the `environment:` key) plus workflow job summaries are the
  authority for "what is live and how did it get there". Workflows never commit to `main`, so no
  deploy ever writes a file into the deployed tree.
- Splitting the four states is a policy change, not a bug fix. Reverting it requires a superseding
  ADR.

---

## ADR 013 — GitHub Actions is the only deployer; merging is the deploy

**Date:** 2026-11-19

**Status:** Accepted; implementation pending (milestone M5, `docs/plan-deployment-alignment.md`)

**Context:** `scripts/deploy.sh` was the documented deploy path, but it was optional

### Context
`deploy.sh` wrapped `gh pr merge`, dispatched migrations, waited for Vercel, and recorded the
result. The actual deploy trigger, however, was Vercel's Git integration reacting to the merge. Any
merge performed through the GitHub UI, `gh`, or an agent skipped the script entirely: migrations
ran late or not at all, Vercel deployed regardless, and nothing recorded what happened.

Gate strength that depends on the actor remembering a local script is not a gate. The rulesets
require a PR and the `verify` check, so merges are audited — but audit is not ordering.

### Decision
- **Merging is the deploy.** Every push to `staging` and `main` starts the corresponding GitHub
  Actions workflow. `workflow_dispatch` exists only for break-glass recovery.
- Vercel's Git auto-deploy is disabled for those two branches **only after** the replacement
  workflow has been proven against them; feature-branch previews are unchanged until per-PR
  databases are proven.
- Deploy order is fixed inside the workflow: **build → migrate → stage → verify candidate →
  promote → verify live**. A broken build never touches the database; a candidate is never promoted
  without proving its own identity.
- Migration-bearing production releases require approval of the `production-migrations`
  environment. This is a deploy gate, not a merge gate, and does not conflict with the catch-22
  rule in `docs/PR_WORKFLOW.md` §0: it delays a job, never a merge, and the operator is already the
  sole merge authority.
- Promotion is merge-commit-only, enforced server-side (`HEAD^2` equals the `staging` tip), because
  a squash merge of a fast-forwardable promotion produces an identical **tree** and would otherwise
  pass tree equality while destroying ancestry.
- Rollback is an alias move to the previous deployment. It never reverts schema. A failed release
  after a successful migration is fixed forward, or the application is rolled back only once
  compatibility is established.

### Consequences
- `scripts/deploy.sh` is retired once Deployments-aware monitoring exists; `scripts/promote.sh`
  only opens the promotion PR and watches the resulting run.
- `migrate.yml` becomes break-glass (verify plus emergency forward-fix) with the same gates.
- `docs/deploys.md` is frozen; GitHub Deployments and job summaries are the record.
- "Merged but not live" becomes a reported state rather than an inference from email.
- Reverting this requires a superseding ADR and a proven replacement deploy path, not just a
  preference for a local script.
