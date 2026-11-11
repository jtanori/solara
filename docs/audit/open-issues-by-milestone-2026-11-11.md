# Solara — open issues by milestone

**Snapshot:** 2026-11-11 · `staging` @ `e030672` · **61 open issues**
Generated from `gh issue list --state open -L 200 --json number,title,milestone,labels,createdAt,updatedAt`.

| Milestone | Open | Closed |
| --- | --- | --- |
| M1 - Foundation | 18 | 8 |
| M2 - Billing | 1 | 1 |
| M3 - Launch readiness | 41 | 10 |
| Final - Platform validation | 0 | 1 |
| **No milestone** | **1** | — |
| **Total** | **61** | |

---

## ⚠ Read this before trusting the `status:` labels

A `status:` label on these issues describes *intent*, not *reality*. Checked against merged PRs:

**Merged into `staging` and never closed.** GitHub only auto-closes `Closes #N` when the PR targets the **default branch**, and the default branch here is `main` (`gh api repos/jtanori/solara --jq .default_branch` → `main`). Every PR merges into `staging`. Observed directly on #133: its body said `Closes #132`, it merged, **#132 stayed open**.

| Issue | Claims | Merged PR that says `Closes #…` | Label today |
| --- | --- | --- | --- |
| #53 auth rate-limit + non-blocking scrypt | LAUNCH BLOCKER | #118 | `status:ready` |
| #54 email transport + verification | LAUNCH BLOCKER | #118 | `status:ready` |
| #55 password reset | LAUNCH BLOCKER | #125 | `status:awaiting-promotion` |
| #56 CSRF / same-origin | — | #118 | `status:ready` |
| #60 DB pool + TLS | — | #125 | `status:ready` |
| #64 migration drift check | — | #126 | `status:awaiting-promotion` |
| #70 health/ready split | — | #126 | `status:awaiting-promotion` |
| #72 ADR 006 | — | #126 | `status:ready` |
| #78 ADR 007 | — | #126 | `status:ready` |
| #84 harden `/api/places` | — | #125 | `status:ready` |
| #87 PII redaction + structured logs | — | #125 | `status:ready` |
| #103 readings generation pipeline | — | #127 | `status:ready` |
| #119 exact-SHA migrate for promotion | — | #120 | `status:ready` |
| #132 retire the committed legacy backlog file | — | **#133** (merged `d7d7634`) | `status:in-progress` |

That is **14 issues whose work is on `staging` and which are still open**, several labelled `status:ready` as if unstarted. It almost certainly explains #93 and #71 being filed *after* the work landed. Closing them is pending a promotion to `main`, or a manual close now.

**Other anomalies found while generating this list:**

- `#78` and `#72` ask to "record ADR 007" and "record ADR 006" — **both ADRs already exist** in `docs/decisions.md`, with `Issue: #78` and `Issue: #72` in their headers.
- `#93` asks to remove `users.plan`; `#71` asks to put schema/readiness verification into `AGENTS.md` and the PR template — `AGENTS.md` §105 and the PR template already contain the readiness/schema contract.
- `#103` ("generation pipeline") is open while migration `0003_readings_documents_generation_cache` and the whole `src/readings/` tree are on `staging`.
- `#117` was reported as closed, and was, but a *duplicate* issue `#116` titled literally `probe` also exists, closed.

---

# M1 — Foundation (18 open / 8 closed)

| # | Title | Priority | Area | Status |
| --- | --- | --- | --- | --- |
| #60 | db: explicit pool configuration and TLS verification | p1 | db | `ready` ⚠ merged via #125 |
| #61 | security: remove inert `channel_binding` guidance, add safe URL helper and secret scan | p2 | docs | `ready` |
| #63 | infra: single source of truth for `DATABASE_URL` and an explicit preview-database policy | p1 | infra | `ready` |
| #65 | db: add indexes for dashboard, session and audit queries | p2 | db | **`blocked`** |
| #66 | db: purge expired sessions and share revocation helpers | p2 | db | `ready` |
| #67 | auth: allow users to change their password | p2 | auth | `ready` |
| #68 | auth: add sign-out-everywhere and optional session list | p2 | auth | `ready` |
| #69 | security: require re-authentication for destructive actions | p2 | auth | `ready` |
| #71 | docs: make schema and readiness verification part of `AGENTS.md` and the PR template | p2 | docs | `ready` ⚠ likely already done |
| #83 | realtime: decide and implement the state-update channel (billing, artefacts) | p2 | backend | `ready` |
| #86 | reliability: add app-router error boundaries, 404 and loading states | p2 | ui | `ready` |
| #91 | quality: validate environment configuration at boot (typed env module) | p2 | backend | `ready` |
| #92 | quality: add e2e smoke journey, coverage floor and performance budgets | p2 | infra | `ready` |
| #93 | db: remove `users.plan` as a source of entitlement | p3 | db | `ready` |
| #94 | ops: incident response runbook, kill-switches and status communication | p2 | infra | `ready` |
| #135 | test: DB-touching tests fail instead of skipping when `DATABASE_URL` is unset | p2 | backend | `ready` |
| #136 | deploy: add `--dry-run` to `scripts/deploy.sh` | p2 | infra | `ready` |
| #138 | feat(observability): build-number probe to prove which build an environment is running | p2 | infra | `needs-triage` |

**Notes.** #135 is the measured defect from the audit: 252/238/10/4 without `DATABASE_URL`, 289/250/2/37 with one. #136 and #138 came out of this session. #138 is the only issue in this milestone not yet triaged.

---

# M2 — Billing (1 open / 1 closed)

| # | Title | Priority | Area | Status |
| --- | --- | --- | --- | --- |
| #10 | chore: validate Stripe test-mode subscription lifecycle | p2 | billing, infra | **`blocked`** |

**Notes.** Blocked on a live Stripe test-mode run. The only issue in this milestone, and the only milestone with no work in flight.

---

# M3 — Launch readiness (41 open / 10 closed)

## p0 — launch blockers

| # | Title | Area | Status |
| --- | --- | --- | --- |
| #53 | auth: rate-limit sign-up/sign-in and make password hashing non-blocking | auth | `ready` ⚠ merged via #118 |
| #54 | auth: add email transport and email verification | auth | `ready` ⚠ merged via #118 |
| #55 | auth: add password reset flow | auth | `awaiting-promotion` ⚠ merged via #125 |
| #105 | readings: consent capture and privacy copy for AI generation | auth, docs | `ready` |
| #131 | infra: configure mail transport and related secrets for staging and production | auth, infra | `ready` |

## p1 — launch gate

| # | Title | Area | Status |
| --- | --- | --- | --- |
| #56 | security: enforce strict same-origin/CSRF checks on mutating routes | auth | `ready` ⚠ merged via #118 |
| #57 | security: add security headers and a Content-Security-Policy | ui | `ready` |
| #58 | auth: add TOTP MFA for owner and admin accounts | auth | `ready` |
| #59 | db: separate application and migration roles (least privilege) | db | `ready` |
| #62 | infra: configure and test database backup/restore (one recorded drill) | infra | `ready` |
| #64 | db: make the migration drift check work and enforce it in CI | infra | `awaiting-promotion` ⚠ merged via #126 |
| #70 | ops: split liveness (`/api/health`) from readiness (`/api/ready`) | infra | `awaiting-promotion` ⚠ merged via #126 |
| #72 | docs: record ADR 006 — identity, credential ownership, Neon Auth decision | docs | `ready` ⚠ ADR exists |
| #74 | ci: verify migration journal integrity (schema/DB parity, immutable applied migrations) | infra | `ready` |
| #75 | ci: turn `migrate.yml` into a gated pipeline (plan, approval, lock, post-verify, audit) | infra | `ready` |
| #76 | infra: make `deploy.sh` fail-closed (pre-merge readiness, verified rollout, rollback, release records) | infra | **`in-progress`** |
| #77 | infra: add error tracking and alerts for auth failures and readiness | infra | `ready` |
| #78 | docs: record ADR 007 — migrations, deployments and rollback policy | infra | `ready` ⚠ ADR exists |
| #79 | tracking: migration + deployment pipeline and auth hardening (launch gate) | infra | `ready` |
| #81 | storage: decide and implement the PDF artefact and file storage architecture | backend, infra | `ready` |
| #82 | data: retention, export and erasure policy for user PII | backend, docs | `ready` |
| #84 | security: harden `/api/places` (unauthenticated keyed proxy, no rate limit) | backend | `ready` ⚠ merged via #125 |
| #85 | productization: legal pages, sign-up consent, SEO metadata | ui, content | `ready` |
| #87 | security: redact PII from server logs, structured logging with request ids | backend | `ready` ⚠ merged via #125 |
| #88 | security: supply-chain controls (pinned actions, SBOM, dependency review) | infra | `ready` |
| #89 | governance: CODEOWNERS, required approvals and branch hygiene | infra | `ready` |
| #90 | security: secret inventory, target assignment and rotation policy | infra | `ready` |
| #99 | epic: the reading document — full solar-revolution interpretation | content, astro | `ready` |
| #100 | readings: domain model + chart digest types | backend, astro | **`in-progress`** |
| #103 | readings: generation pipeline (prompt registry, schema validation, cache, freeze) | backend, content | `ready` ⚠ merged via #127 |
| #104 | readings: free-tier sections and locked teasers | ui, content | `ready` |
| #107 | billing: generate paid sections on entitlement | backend, billing | `ready` |
| #108 | readings: cost guards, per-reading budget ceiling and kill switch | backend, infra | `ready` |
| #109 | readings: eval harness and astrologer review gate | content, astro | `ready` |
| #119 | ci: require exact SHA and a real migrate run for production promotion | infra | `ready` ⚠ merged via #120 |
| #128 | readings: test the repair branch of the usage guard (SEC-07 follow-up) | backend | `ready` |
| #129 | readings: invalid-usage attempts are invisible to the spend ledger | backend | `ready` |

## p2 / p3

| # | Title | Priority | Area | Status |
| --- | --- | --- | --- | --- |
| #106 | readings: renderer for page and PDF | p2 | ui, backend | `ready` |
| #110 | engine: profections and transits | p2 | astro | `ready` |
| #132 | chore: retire the committed legacy backlog file in favor of an on-demand, generated snapshot | p2 | docs, infra | **`in-progress`** ⚠ merged via #133 |
| #111 | readings: astrologer review and override tooling | p3 | ui, content | `ready` |

---

# No milestone (1 open)

| # | Title | Priority | Area | Status |
| --- | --- | --- | --- | --- |
| #134 | docs: make PR review completion procedural, not prompt-dependent | **p1** | docs | `needs-triage` |

**Notes.** This is the only open issue outside a milestone, and it is `p1` — the highest-priority unassigned item. It came directly out of #133's six review rounds, three of which caught documentation defects that the existing tests passed. `M1 - Foundation` is the natural home.

---

## Where the real work is

- **51 of 61 open issues carry `status:ready`.** With 14 of those already merged to `staging`, "ready" is not a queue — it is a label nobody has revisited.
- **`status:in-progress`: 3** — #76, #100, #132. #132 is merged.
- **`status:blocked`: 2** — #65 (index design) and #10 (Stripe lifecycle).
- **`status:awaiting-promotion`: 3** — #55, #64, #70. These are waiting for the **first ever promotion to `main`**, which has not happened.
- **`status:needs-triage`: 2** — #134 (no milestone) and #138.
- **Priority spread (measured, one label per issue):** p0 ×5, **p1 ×35**, p2 ×19, p3 ×2. Note p1 is the largest bucket by a wide margin — 57% of the backlog is "launch gate".

## Suggested cleanup, in order

1. **Close the 14 merged-but-open issues** — or, better, do the first promotion to `main`, which resolves them properly and clears the three `awaiting-promotion` items at the same time.
2. **Re-triage `status:ready`** — it currently means "nobody has looked since filing".
3. **Archive or close #72, #78, #71** — the artifacts they ask for exist.
4. **Assign #134 to `M1 - Foundation`.**
5. **Decide #132's fate** — its PR merged; only the promotion stands between it and `closed`.
