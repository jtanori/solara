# Deep audit — database, auth, storage, security, real-time, deployment, branching, secrets

**Date:** 2026-11-08 · **Branch:** `arena/8f0da984-solara` (PR #80) · **Scope:** whole repository, read-only
**Companions:** `docs/audit-database-integration.md` (DB deep dive), `docs/plan-neon-auth-migration.md` (auth deep dive)
**Method:** every claim below was reproduced in this checkout — `src/` read end to end, `git`/`gh` state queried, `pg@8.20.0` / `drizzle-orm@0.45.2` / `drizzle-kit@0.31.10` behaviour tested directly. Anything not verifiable from here is marked **[unverifiable from sandbox]**.

---

## 0. How to read this

| Column | Meaning |
|---|---|
| **ID** | `DOMAIN-nn` — stable, cite it in issues/PRs |
| **Sev** | `S1` = blocks launch · `S2` = fix before real traffic · `S3` = hardening/quality |
| **Issue** | the GitHub issue that tracks it (`#nn`), or "—" if it is covered elsewhere |

Findings that were already logged in #52–#78 are cross-referenced, not re-filed. **New issues are #81–#94.**

---

## 1. Scorecard

| Domain | Grade | Launch blockers | Notes |
|---|---|---|---|
| **Database** | C− | 4 open (#52, #59, #62, #64) | schema/migration files correct; provisioning + least privilege + backups missing |
| **Auth** | D+ | 5 open (#53–#57) | crypto sound, operational surface missing |
| **File storage** | N/A → F | 1 new (#81) | **no storage layer exists at all**; PDFs rendered per request |
| **Security** | D | 4 open (#56, #57, #58, #69) + 3 new (#84, #87, #88) | no headers/CSP, no rate limits, no log redaction, no supply-chain controls |
| **Real-time** | N/A | 1 new (#83) | none implemented; the billing "live" indicator is client polling |
| **Deployment** | D | 4 open (#70, #75, #76, #77) + 2 new (#89, #90) | pipeline exists, verification is decorative |
| **Branching** | C | 1 new (#89) | ADR 001/004 are good; enforcement allows self-merge of `main` |
| **Secrets** | C− | 2 open (#61, #63) + 1 new (#90) | no inventory, no rotation, inert control documented |
| **Observability** | F | 1 open (#77) | zero error tracking |
| **Data lifecycle / PII** | F | 1 new (#82) | no retention, export or erasure beyond account delete |
| **Productization** (legal/SEO/a11y) | F | 1 new (#85) | no privacy/terms pages, no robots/sitemap/OG |
| **Quality gates** | D+ | 2 new (#91, #92) | 13 unit tests, no e2e, no coverage gate, no boot-time config validation |

**Verdict:** this is a *well-structured prototype* with *production-grade intentions* and *prototype-grade enforcement*. The code is conventional and, in places, careful. The failures are systemic: **nothing verifies that the deployed system is what the repository says it is.**

---

## 2. Database

Deep dive: `docs/audit-database-integration.md`. Summary of the items that matter for launch:

| ID | Sev | Finding | Issue |
|---|---|---|---|
| DB-01 | S1 | Hosted schema was never applied; `migrate.yml` never ran; diff-gated dispatch | #52 |
| DB-02 | S1 | One Neon role for app + migrations — runtime can `DROP` | #59 |
| DB-03 | S1 | No backup/PITR/restore evidence | #62 |
| DB-04 | S1 | `drizzle-kit check` exits 1 (config misparse) — the drift gate never worked | #64 |
| DB-05 | S2 | Journal is not verified: schema↔journal parity, edited applied files, snapshot integrity | #74 |
| DB-06 | S2 | Pool has no `max`/timeouts/`error` handler; TLS semantics change in pg 9 | #60 |
| DB-07 | S2 | Only one non-PK index (`subscriptions_user_idx`); `readings`, `sessions`, `audit_logs` scan | #65 |
| DB-08 | S3 | Expired sessions never purged | #66 |
| DB-09 | S3 | `users.plan` is a denormalised duplicate of `subscriptions` state — never updated after signup, still read in one place (`pdf/route.ts` compares `user.plan==="paid"`); the schema comment calls it "legacy display field" | #93 |
| DB-10 | S3 | `audit_logs` is write-only: rows are inserted, but there is no viewer, export or retention | #82 |

**Anti-pattern called out:** the schema comment (`// Legacy display field only`) documents a known-bad column *in the source*, and the code keeps writing it at signup (`plan:"free"`). Documentation as a substitute for removal is how dead state becomes load-bearing.

---

## 3. Authentication

Deep dive + S1–S10: `docs/plan-neon-auth-migration.md` §2. What is *right* (do not "fix"): scrypt with default parameters, `timingSafeEqual`, 32-byte random session tokens stored only as SHA-256, `httpOnly`+`SameSite=Lax`+`Secure` cookies, enumeration-resistant errors, server-side role checks, ownership checks on readings/PDFs.

| ID | Sev | Finding | Issue |
|---|---|---|---|
| AU-01 | S1 | No rate limit / lockout / captcha; `scryptSync` blocks the event loop | #53 |
| AU-02 | S1 | No email transport, verification or reset — forgotten password = permanent lockout | #54, #55 |
| AU-03 | S1 | `sameOrigin()` returns `true` when `Origin` is absent | #56 |
| AU-04 | S1 | No MFA for `owner`/`admin` | #58 |
| AU-05 | S2 | No password change, no global revocation | #67, #68 |
| AU-06 | S2 | Destructive actions need only a cookie (role change, account deletion) | #69 |
| AU-07 | S2 | No identity/auth decision record (blocks every future choice) | #72 |

---

## 4. File storage — **no layer exists**

| ID | Sev | Finding |
|---|---|---|
| ST-01 | S1 | **No storage abstraction at all.** `grep -rniE "s3\|blob\|upload\|multer\|@vercel/blob\|cloudinary" src` → zero hits. Nothing is persisted outside Postgres. |
| ST-02 | S2 | **PDFs are rendered per request** (`src/app/api/readings/[id]/pdf/route.ts`): `@react-pdf/renderer` runs inside the request, dynamic import each time, no caching, no artefact. Cost doubles at every download; a slow render holds a serverless invocation; the same bytes are recomputed forever. `Cache-Control: private, no-store` is correct for privacy but means zero reuse *even for the owner*. |
| ST-03 | S2 | **No upload path and no policy for one.** If avatars, birth-chart photos or editorial images are ever added, there is no decision on size caps, MIME sniffing, malware scanning, signed URLs, or per-user quotas. |
| ST-04 | S3 | **No artefact lifecycle:** a future stored PDF has no TTL, no regeneration strategy after editorial content changes (knowledge edits change the rendered text — a cached PDF would silently go stale). |

**Tracked as #81** (decision + implementation: object storage, signed short-lived URLs, render-once-then-cache keyed by `(readingId, contentVersion)`, size limits, upload policy).

**Why it matters for a first-class product:** the moment there is a stored artefact, *storage becomes an availability and privacy dependency*. Deciding now (even to say "we will never store files") is cheaper than discovering it during the first support request for a broken download.

---

## 5. Security (beyond auth)

| ID | Sev | Finding | Issue |
|---|---|---|---|
| SE-01 | S1 | No security headers, no CSP, no middleware/proxy to enforce them | #57 |
| SE-02 | S1 | **`/api/places` is an open, unauthenticated proxy to a *keyed* upstream.** No `sameOrigin`, no rate limit, no cache. Anyone can loop it: burns the Open-Meteo quota and turns the app into a free geocoder. (`grep` for `rate|Origin|sameOrigin` in that file → nothing.) | #84 |
| SE-03 | S2 | **PII can reach server logs.** `console.error("Authentication error", error)` on the auth route logs the Drizzle error object, which carries the **query and params** — i.e. `antunewenale@gmail.com`. The same pattern exists in `/api/readings` (`console.error("Unable to save solar return", error)` — the chart input contains birth date, time and place). | #87 |
| SE-04 | S2 | **No supply-chain controls.** Actions are pinned to mutable tags (`actions/checkout@v4`, `setup-node@v4`); no `npm audit` signature/SBOM, no dependency review, no license check; Dependabot has **12 open PRs** including `typescript 7.0.2` and `eslint 10.14.0` majors sitting unreviewed. | #88 |
| SE-05 | S2 | **No legal/consent surface**: no `/privacy`, `/terms`, cookie notice, or consent record — while collecting birth date, time and place. The blueprint page *describes* the policy instead of hosting it. | #85 |
| SE-06 | S3 | No `X-Frame-Options`/`frame-ancestors` (clickjacking on the dashboard + admin), no `Referrer-Policy` (charts leak via `Referer` to tile/geocoding hosts) | #57 |
| SE-07 | S3 | No CSRF-independent defence for the `GET`-side (nothing mutates on GET — verified — which is good) | — |
| SE-08 | S3 | Webhook endpoint is correctly signature-verified before parsing; no replay window beyond `stripe_events` idempotency (acceptable) | — |

**Positive:** no `dangerouslySetInnerHTML` anywhere; the file-upload XSS class does not exist yet (ties to #81); Stripe secrets stay server-side; `OPEN_METEO_API_KEY` is never exposed to the client and keyed requests bypass the data cache deliberately.

---

## 6. Real-time

| ID | Sev | Finding |
|---|---|---|
| RT-01 | S2 | **No real-time layer.** `grep -rniE "websocket\|socket.io\|eventsource\|sse" src` → zero. The only "live" behaviour is `BillingSync` on the dashboard, which relies on `?billing=success` plus a client-side refresh after Stripe redirects. |
| RT-02 | S2 | Stripe subscription state is eventually consistent and the UI has no push channel: a webhook arriving 30 s late leaves the user staring at "we're waiting for confirmation" until they refresh. |
| RT-03 | S3 | Postgres `LISTEN/NOTIFY`, `pg_notify` triggers and Neon's logical replication are all unused — so **no** infrastructure exists for "new reading ready", "plan upgraded", or collaborative editing. |

**Tracked as #83** (decision record + minimal implementation: SSE endpoint or polling-with-backoff; explicitly *not* a WebSocket server on Vercel).

**Why log it at all:** a first-class product inevitably needs at least one push channel (billing state, long-running PDF generation, editorial publishing). Deciding "polling only, here is the budget" is a legitimate answer; having *no* answer is not.

---

## 7. Deployment

| ID | Sev | Finding | Issue |
|---|---|---|---|
| DE-01 | S1 | `/api/health` is `select 1` — the gate that stayed green through #52 | #52, #70 |
| DE-02 | S1 | `deploy.sh` merges **then** verifies, and the failure branch is `WARN` + exit 0; no pre-merge check against the preview deployment; no rollback; no release tags (`git tag` empty) | #76 |
| DE-03 | S1 | `migrate.yml`: no plan step, no approval, no DB advisory lock, no post-verify, no audit trail, environments distinguishable only by secret | #75 |
| DE-04 | S1 | Baked images contain no health signal: Vercel has no readiness probe, so a deploy that boots against an empty DB is indistinguishable from a good one | #70 |
| DE-05 | S2 | No error tracking or alerting; #52 was reported by a user | #77 |
| DE-06 | S2 | Two sources of truth for `DATABASE_URL` (Vercel env + GitHub Environment) with no comparison | #63 |
| DE-07 | S3 | Preview deployments have no documented database target | #63 |
| DE-08 | S3 | No `robots.txt`/`sitemap.xml`/OG image/`manifest` and no `metadataBase` — crawlers and link previews get nothing | #85 |
| DE-09 | S3 | `.nvmrc` missing while `engines.node >= 22` is declared — local/CI drift is possible (CI pins 22, Vercel pins its own default) | #89 |

---

## 8. Branching strategy

**What is good (keep it):** `feature → staging → main` (ADR 001), squash for features / merge commit for promotions (ADR 004), two active rulesets (`protect-main`, `protect-staging`) with `deletion`, `non_fast_forward`, `required_status_checks` (`verify`, strict), and `pull_request` + `required_review_thread_resolution: true`. `delete_branch_on_merge: true` and `allow_rebase_merge: false` are set on the repo.

| ID | Sev | Finding | Issue |
|---|---|---|---|
| BR-01 | S1 | **`required_approving_review_count: 0` on *both* rulesets**, and `require_code_owner_review: false`, no `CODEOWNERS` file. In practice a single collaborator — or any future collaborator — can self-merge to `main` with no review, while the docs claim "PR required". | #89 |
| BR-02 | S2 | **Merge-method mismatch.** The rulesets allow `["merge","squash","rebase"]`; the repo setting forbids rebase, and ADR 004 wants squash-for-features/merge-for-promotions. Three-way disagreement means the policy is enforced by a shell script (`deploy.sh`), not by GitHub. | #89 |
| BR-03 | S2 | **No required review on the promotion PR** (`staging → main`) even though it is the only path to production. | #89 |
| BR-04 | S3 | Stale `arena/*` branches (8+), `dependabot/*` branches (12) and `arena/promote-*` remain on the remote — branch hygiene affects humans, not correctness, but it obscures "what is live". | #89 |
| BR-05 | S3 | The audit branch itself is based on `main` while `staging` has 40 commits `main` lacks and **unrelated history** — a direct consequence of the promotion model, and a trap for anyone cherry-picking blindly. | — (documented in #80) |

**Anti-pattern:** *policy by prose.* ADR 001/004 describe a review flow the platform does not enforce. The moment a second human joins, the gap becomes a silent bypass.

---

## 9. Secret handling & target assignment

### 9.1 Current state

| ID | Sev | Finding | Issue |
|---|---|---|---|
| SH-01 | S2 | **No secret inventory**: nothing states, in one place, which secret lives where, which scope it belongs to, who owns it, or how it is rotated. `.env.*.example` documents *shape*, not *ownership*. | #90 |
| SH-02 | S2 | **No rotation policy or procedure** for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `DATABASE_URL`, `OPEN_METEO_API_KEY`. Rotation is not exercised, so the first rotation will be an incident. | #90 |
| SH-03 | S2 | **No verified separation of prod vs preview**: the same variable name is added to Preview and Production scopes by hand; nothing asserts that a Preview build never received a production credential (#63 covers comparison, #90 covers audit/rotation). | #63, #90 |
| SH-04 | S3 | `LOCAL_SEED_PASSWORD` / `ALLOW_LOCAL_SEED*` guards are **good** (fail-closed in CI/Vercel, loopback host check). Keep. | — |
| SH-05 | S3 | `channel_binding=require` is documented as a control and is a **no-op** in `pg` | #61 |
| SH-06 | S3 | No secret scanning in CI (nothing fails if a credential lands in a file or an issue) | #61 |
| SH-07 | S3 | `.gitignore` coverage is adequate — only `*.example` files are tracked (verified via `git ls-files`) | — |

### 9.2 Target assignment matrix (the answer to "which one goes where")

**Rule: one variable, one owning scope, one consumer.** Anything in Vercel must be *runtime-only*; anything in GitHub Environments must be *migration/CI-only*; `.env*` locally must be loopback or a disposable branch.

| Variable | Local (`.env`) | Vercel **Preview** (`staging` branch) | Vercel **Production** | GitHub Env `staging` | GitHub Env `production` | Consumer | Rotation |
|---|---|---|---|---|---|---|---|
| `DATABASE_URL` (pooled, `sslmode=verify-full`) | `127.0.0.1` disposable | staging pooler, **app role** | prod pooler, **app role** | — | — | `src/db` | on compromise / quarterly |
| `DATABASE_URL` (direct, non-pooler) | ditto | ❌ never | ❌ never | staging direct, **migrator role** | prod direct, **migrator role** | `migrate.yml` | same as above |
| `APP_URL` | `http://localhost:3000` | `https://solara-stg.vercel.app` | `https://solara-production.vercel.app` | same as Vercel | same | origin checks, Stripe redirects | static |
| `STRIPE_SECRET_KEY` | test mode | test mode | **live** | — (not needed by migrations) | — | billing routes | yearly / on staff change |
| `STRIPE_WEBHOOK_SECRET` | test endpoint | test endpoint | live endpoint | — | — | `/api/billing/webhook` | per endpoint recreation |
| `STRIPE_PRICE_ID_USD` / `_MXN`, `STRIPE_PREMIUM_PRICE_IDS` | test prices | test prices | live prices | — | — | checkout | with pricing changes |
| `OPEN_METEO_API_KEY` | optional | optional (shared quota risk) | recommended | — | — | `/api/places` | quarterly |
| `NEXT_PUBLIC_MAP_TILE_URL` / `_ATTRIBUTION` | default OSM | default | **licensed provider** | — | — | Leaflet | n/a |
| `LOCAL_SEED_PASSWORD`, `ALLOW_LOCAL_SEED*` | only here | ❌ hard refuse | ❌ hard refuse | ❌ | ❌ | seed script | n/a |
| `SENTRY_DSN`/`AUTH_TOKEN` (planned) | optional | staging project | prod project | — | — | #77 | yearly |
| `NEON_AUTH_BASE_URL` / `NEON_AUTH_COOKIE_SECRET` (only if #72 flips) | per-branch | staging branch auth | prod branch auth | — | — | auth server | on compromise |

**Anti-assignments (must never happen):** direct DB URL in Vercel; pooled URL in a GitHub Environment; live Stripe keys in Preview; `NEXT_PUBLIC_*` with anything secret (they are build-baked); any `ALLOW_LOCAL_SEED*` outside a loopback shell.

**Tracked as #90** (inventory + rotation + audit), with #63 (comparison tooling) and #61 (leak detection).

---

## 10. Cross-cutting anti-patterns

These are the *patterns*, not the instances — the reason the same class of bug keeps appearing:

1. **Decorative verification.** Four separate gates existed (`/api/health`, CI smoke, `check-setup.mjs`, `migrate.yml`) and **none** could fail on a wrong system state. Adding checks without defining the failure condition is worse than no check: it manufactures confidence. → #52, #70, #74, #76
2. **Policy by prose.** ADRs and docs describe controls (review, migration ordering, TLS, channel binding) that the platform does not enforce or that are no-ops. → #56, #61, #89
3. **Silent conditional execution.** `if diff touches drizzle/ then migrate` — a step that usually does not run is a step that is never verified. → #52, #75
4. **Shared fate between app and data.** One credential can DDL; one pool has no limits; one request can spend unbounded CPU (`scryptSync`, PDF render, geocoding proxy). → #53, #59, #60, #81, #84
5. **Documented dead state.** `users.plan` ("legacy display field") is still written; `drizzle-kit check` is still in the runbooks. → #93, #64
6. **No observability of the user's path.** Nothing records "sign-in succeeded", so a total auth outage is invisible until a human complains. → #77, #87, #92
7. **Unbounded trust in third parties.** Unpinned actions, un-triaged majors, an unauthenticated keyed proxy, third-party tile requests from authenticated pages. → #84, #88, #57

---

## 11. No-ops & false controls registry

| Control claimed | Reality | Where |
|---|---|---|
| `channel_binding=require` | not read by `pg` at all | `deploy.sh:12`, `env-templates.md`, `00-manual-setup-ui.md` → #61 |
| `npx drizzle-kit check` | exits 1, misparsed config | runbooks → #64 |
| `/api/health` as a readiness gate | `select 1` only | #52, #70 |
| `deploy.sh` post-merge verification | `WARN` + exit 0 | #76 |
| "PR required" on `main`/`staging` | true, but **0 required approvals**, no CODEOWNERS | #89 |
| "Reviewed baseline / migration ordering" docs | no check enforces it | #74, #78 |
| `users.plan` column | never updated, described as legacy | #93 |
| `npm audit` as supply-chain control | no SBOM, no dependency review, actions unpinned, 12 un-triaged PRs | #88 |
| README "health check confirms deployment" | confirms TCP + credentials only | #52 |

---

## 12. What "first class / production ready" means here (checklist)

A product is first-class when each line below is **true and evidenced**, not documented:

**Data** — schema is applied by a pipeline (§DB-01); runtime cannot DDL (§DB-02); restore drilled (§DB-03); journal provably matches the database (§DB-04/05); query plans measured (§DB-07); retention defined (#82).
**Identity** — rate-limited, verifiable, recoverable, revocable, MFA for staff (§AU-01..07).
**Storage** — every artefact has an owner, a TTL, a signed access path and a size limit (#81).
**Security** — headers enforced, every public endpoint authenticated or explicitly budgeted (§SE-01/02), logs carry no PII (§SE-03), supply chain pinned and reviewed (§SE-04), legal surface published (§SE-05).
**Real-time** — an explicit, costed choice, not an absence (#83).
**Delivery** — deploys gated on readiness, fail closed, roll back automatically, and announce themselves (#70, #76, #77, #89).
**Secrets** — inventoried, scoped, rotated, leak-detected (§SH-01..06).
**Operations** — error tracking, alerts with owners, incident runbook, status communication (#77, #94).
**Quality** — boot-time config validation (#91), e2e smoke + coverage + perf budgets (#92), error boundaries (#86).

---

## 13. New issues filed from this audit

| Issue | Title | Sev | Labels |
|---|---|---|---|
| #81 | storage: PDF artefact strategy + file storage architecture decision | S1 | `type:feature area:backend area:infra priority:p1` |
| #82 | data: retention, export and erasure policy for user PII | S1 | `type:security area:backend area:docs priority:p1` |
| #83 | realtime: decide and implement the state-update channel | S2 | `type:feature area:backend priority:p2` |
| #84 | security: harden /api/places (unauthenticated keyed proxy) | S1 | `type:security area:backend priority:p1` |
| #85 | productization: legal pages, consent, SEO metadata | S1 | `type:feature area:ui area:content priority:p1` |
| #86 | reliability: app-router error boundaries and graceful degradation | S2 | `type:bug area:ui priority:p2` |
| #87 | security: redact PII from server logs + structured logging | S1 | `type:security area:backend priority:p1` |
| #88 | security: supply-chain controls (pinned actions, SBOM, dependency review) | S1 | `type:security area:ci priority:p1` |
| #89 | governance: CODEOWNERS, required approvals, branch hygiene | S1 | `type:chore area:infra priority:p1` |
| #90 | security: secret inventory, ownership and rotation policy | S1 | `type:security area:infra priority:p1` |
| #91 | quality: validate environment configuration at boot | S2 | `type:bug area:backend priority:p2` |
| #92 | quality: e2e smoke, coverage gate, performance budget | S2 | `type:test area:ci priority:p2` |
| #93 | db: remove or justify documented dead schema (`users.plan`) | S3 | `type:refactor area:db priority:p3` |
| #94 | ops: incident response runbook and status communication | S2 | `type:docs area:infra priority:p2` |

Epic tracking stays in **#79** (canonical) — it must be updated by hand; the automation token cannot edit issue bodies.

---

## 14. Portable prompt

The reusable audit prompt for the sibling project lives at **`docs/audit/portable-audit-prompt.md`** in this repo. It encodes this method: evidence-first, domain-by-domain, produce IDs, separate *new* findings from *already-logged* ones, then file issues with tags and milestone routing.
