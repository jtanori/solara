# Assessment: moving Solara auth to Neon Managed Better Auth

**Status:** decision pending — report only, no code written.
**Date:** 2026-11-08 · **Branch:** `arena/8f0da984-solara`
**Prerequisite:** [#52](https://github.com/jtanori/solara/issues/52) (schema never applied to hosted DBs).

---

## 0. TL;DR

- **Effort: ~5–7 focused dev days**, realistically **2 calendar weeks** across staging → production,
  plus an unbounded "beta vendor" tail. Roughly **400–700 lines changed/removed** and **12–18 files
  touched**, but the risk is not in the line count — it's in identity migration and session cutover.
- **Biggest win:** deleting our hand-rolled `scrypt` + `sessions` machinery, and gaining email
  verification, password reset, email OTP, social OAuth and admin tooling we currently lack (our own UI
  literally says *"Password recovery, email verification… are planned before launch"*).
- **Biggest cost:** **existing passwords cannot be imported.** `src/lib/passwords.ts` uses a
  non-portable `scrypt` `saltHex:hashHex` format; Managed Better Auth (Better Auth 1.7.12) expects its
  own scrypt/NIST-compatible hasher config. Every current user must reset, or we bridge-verify.
  Given production currently has **zero user rows** (see #52), this cost may be ≈ 0 today — which is
  the single most important fact in this report.
- **Biggest risk:** the vendor surface is young (`@neon/auth` first published 2026-10-08, GA but
  rapidly churning; docs and package names were still drifting weeks ago), and auth becomes a
  per-Neon-branch, region- and plan-constrained dependency. Mitigation: keep our `users` table as the
  domain source of truth and keep a feature flag that reverts to local auth.
- **Recommendation:** **yes, but after #52 lands and only if you accept a forced password reset.** Do it
  in 4 phases with a dual-path rollout (§6), not as a single cutover PR.

---

## 1. What Neon Auth actually is (as of 2026-11-08)

| Dimension | Finding |
| --- | --- |
| Product | **Managed Better Auth** — Neon-hosted auth service built on Better Auth **1.7.12** |
| Where data lives | `neon_auth` schema **inside your own Neon database**, queryable with SQL, RLS-compatible |
| Branching | Auth state branches **with the database** → real auth flows in preview branches |
| SDK | `@neon/auth` **0.8.2** (latest, 2026-10-30). Older `@neondatabase/auth` 0.7.0-beta still works; do **not** mix. Docs previously used `@neondatabase/auth` naming — pin the version you actually test. |
| Next.js shape | `createNeonAuth()` server helper → catch-all `app/api/auth/[...path]/route.ts` exporting `auth.handler()`, plus `proxy.ts` (Next 16) for route protection |
| Env config | `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET` (≥32 chars) — **per Neon project/branch** |
| Status | GA (per roadmap page); MFA still "coming soon"; Organization plugin only partial |
| Pricing | Included in all plans by **MAU**: Free ≤ 60k MAU/project, Launch/Scale ≤ 1M |
| Constraints | **AWS regions only** (no Azure); **not** available with IP Allow or Private Networking enabled |
| Bundled features | email+password, email verification, password reset, email OTP, magic link, social OAuth (Google/GitHub/Vercel/Microsoft/Apple), admin plugin, JWT, phone, webhooks (Ed25519-signed), Neon API/CLI/MCP config |

Solara-specific fit: single-region Vercel + Neon, one Next.js app (no separate frontend/backend
domains — the unsupported "standalone architecture" case does not apply), email/password only today.

---

## 2. Current auth surface in this repo (what has to change)

| File | Role today | Fate under Neon Auth |
| --- | --- | --- |
| `src/app/api/auth/route.ts` | signup / login / DELETE logout, JSON + cookie | **Replaced** by catch-all `[...path]/route.ts` handler (keep a thin compatibility shim or migrate the form) |
| `src/lib/auth.ts` | `hashToken`, `createSession`, `SESSION_COOKIE`, `currentUser()` (+ `hasPremiumAccess`, `canManageUsers`, `canEditKnowledge`, `sameOrigin`) | `currentUser()` rewritten on `auth.getSession()`; session helpers/cookie **deleted**; authorisation helpers **kept** |
| `src/lib/passwords.ts` | `scrypt` `salt:hash` | **Deleted** (except a temporary legacy-verify bridge, §5) |
| `src/db/schema.ts` → `sessions` table | token-hash sessions, FK → `users` | **Dropped** (Neon Auth owns sessions in `neon_auth`), needs a migration |
| `src/db/schema.ts` → `users.password_hash` | NOT NULL password hash | Becomes **nullable/dropped**; identity lives in `neon_auth.user`, our row keeps domain fields (`role`, `stripe_customer_id`) |
| `src/components/auth-form.tsx` | custom bilingual form posting JSON to `/api/auth` | Re-pointed at `authClient.signUp/signIn` (also unlocks sign-out, reset, verify flows) |
| 18 `currentUser()` call sites (pages + 6 API routes) | unchanged signatures | unchanged **if** `currentUser()` keeps its return shape `{id,name,email,role,stripeCustomerId,plan}` |
| `scripts/local/seed-users.ts`, `scripts/run-local-checks.sh`, `scripts/verify-gating-production.ts`, `tests/*` | insert `users` with `passwordHash` | Must create auth users via admin API/CLI or a seeded session — **the main hidden work item** |

Because `currentUser()` is the single choke point, the blast radius on call sites is genuinely small.
The pain is in tests/seeders and the `drizzle` migration, not in 18 refactors.

---

## 3. Decisions you need to make (with a recommendation each)

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | **Identity ownership** | (a) `neon_auth` only; (b) our `users` stays source of truth for domain data, linked via `auth_user_id` | **(b)** — `subscriptions`, `readings`, `audit_logs`, Stripe customer mapping all FK to `users.id`; rewriting those FKs is risk without payoff |
| D2 | **Existing-password strategy** | (a) forced reset on next login; (b) dual-verify bridge (try Better Auth, fall back to `verifyPassword`, then link); (c) silent migration with rehash | **(a) if prod really has 0 users (verify via #52)**; otherwise **(b)**, time-boxed 60 days, then delete `passwords.ts` |
| D3 | **`sessions` table** | Drop now / keep orphaned | **Drop in a dedicated migration** after cutover is proven; keep read path off it from day one |
| D4 | **`users.id` stability** | Keep UUID PK and add `auth_user_id text unique` / Replace PK with `neon_auth` id | **Keep** — every FK and Stripe mapping depends on it |
| D5 | **Email flows transport** | Neon default mailer vs custom SMTP | **Custom SMTP before launch** (deliverability + brand); Neon's default is prototyping-grade |
| D6 | **Admin/role model** | Keep `role` in our `users` (owner/admin/editor/user) vs Better Auth admin plugin | **Keep ours** for app permissions; optionally enable the admin plugin later only for user CRUD |
| D7 | **Client integration** | Full catch-all proxy through our Next app vs direct browser→Neon URL | **Proxy through Next** (`/api/auth/[...path]`) — keeps cookies first-party, blocks admin endpoints, avoids CORS/trusted-domain churn |
| D8 | **Environments** | One Neon auth instance vs one per branch/environment | **One per environment** (`staging`, `production`) + preview branches with auth auto-provisioned, each with its own cookie secret |
| D9 | **Regional constraint** | Accept AWS-only, no IP Allow | **Accept** — verify the production Neon project is AWS and has neither IP Allow nor Private Networking enabled **before** committing |
| D10 | **Rollback stance** | One-way door vs reversible | **Reversible for 1 milestone:** keep local auth code behind `AUTH_PROVIDER=local\|neon` until staging + prod have run a week clean |

---

## 4. Effort estimate

| Workstream | Estimate | Notes |
| --- | --- | --- |
| 0. Prerequisite #52 (schema applied + health becomes a schema gate) | 0.5–1 d | Non-negotiable; Neon Auth creates tables via *its* migration path and will look just as invisible to `/api/health` otherwise |
| 1. Provision auth per environment (Console/CLI, `NEON_AUTH_BASE_URL`, cookie secret, trusted domains, SMTP, disable/keep sign-up policy) | 0.5 d | ×2 envs + preview branches; mostly owner-only UI clicks (same class of work as ADR 003 setup) |
| 2. Server integration (`lib/auth/server.ts`, catch-all route, `proxy.ts` matcher, remove legacy route) | 1 d | Straight port of the documented shape; the matcher is where bugs hide |
| 3. Rewrite `currentUser()` + user provisioning (link `auth_user_id`, JIT-create domain row on first sign-in) | 1–1.5 d | Must keep the return shape so 18 call sites stay untouched |
| 4. Schema migration (`users.password_hash` nullable, `sessions` drop, `auth_user_id` add + backfill) | 0.5 d | One drizzle migration + journal entry; needs the #52 gate to be trustworthy |
| 5. Front-end (`auth-form.tsx` → SDK, sign-out, verify-email and reset-password screens, bilingual copy) | 1–1.5 d | New UI work we don't have today — this is where scope creeps |
| 6. Tests, seeders, verifiers (`seed-users.ts`, `run-local-checks.sh`, `verify-gating-production.ts`, 2 test files, CI auth smoke) | 1.5–2 d | **Most underestimated item**: every fixture assumes `passwordHash` |
| 7. Dual-path rollout + docs (env templates, runbooks, ADR 006, `AGENTS.md`, `BACKLOG.md`) | 1 d | |
| **Total** | **~7 dev days (5 optimistic / 10 pessimistic)** | Plus 3–5 days of real-world burn-in on staging |

What does **not** change: Stripe sync, readings, PDFs, knowledge, audit logs, i18n, the deployment
pipeline (beyond two new env vars per environment).

---

## 5. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Password migration impossible** (scrypt format not portable) | Certain | Users must reset | Forced-reset flow + clear email; or time-boxed dual-verify bridge (D2) |
| **Vendor youth / churn** — `@neon/auth` first published 2026-10-08, docs renamed packages and drifted, MFA not yet available | Medium | Rework, breaking changes | Pin exact version, wrap SDK behind `lib/auth/server.ts`, keep `currentUser()` as the only consumer, watch roadmap before adding plugins |
| **Per-environment misconfiguration** — `NEON_AUTH_BASE_URL` from staging leaking into production (exactly the class of bug #52 exposed) | Medium | Users land in the wrong identity store | Explicit env matrix in `docs/setup/env-templates.md`, `check:setup` assertion comparing expected branch/host per env, both endpoints probed in smoke |
| **Auth tables land in `neon_auth`, not `public`** → our health gate still green while auth is broken | High if #52 isn't fixed first | Repeats this incident | Health probe must include `to_regclass('neon_auth.user')` **and** `public.users` |
| **Preview-branch sprawl** — every Vercel preview gets an auth instance + costs/permissions | Medium | Noise, stray sign-ups | Disable auth on previews unless explicitly enabled; document in runbook |
| **Cookie/domain mistakes** (`NEON_AUTH_COOKIE_SECRET`, trusted domains, cross-subdomain) | Medium | Silent login failures | Register `solara-stg.vercel.app` + `solara-production.vercel.app` + custom domain as trusted; test both envs explicitly |
| **Session cutover logs everyone out mid-flight** | High (if users exist) | UX | Accepted; do it in a low-traffic window, communicate reset |
| **Vendor lock-in** — auth state tied to Neon branches/regions | Low–Medium | Migration cost later | D1 (own users table) + a `password_hash` re-population path or export of `neon_auth` hashes keeps an exit; Better Auth's schema is portable in principle |
| **Beta-to-GA changes in `neon_auth` schema** | Low (now GA) | Migration churn | Don't query `neon_auth` tables directly in app code; use SDK |
| **Data-protection review** — user identities now sit in a managed service | Low | Compliance friction | Same Neon project/region as the DB; note in ADR/privacy page |

---

## 6. Proposed plan (only if you say go)

**Phase 0 — prerequisites (before any Neon Auth work)**
1. Close out #52: migrate staging + production, make `/api/health` a 4-relation + `neon_auth`-aware
   schema gate, verify with a throwaway branch.
2. Answer the **zero-users question** with evidence (`select count(*) from users`). It decides D2.
3. Confirm the production Neon project satisfies D9 (AWS, no IP Allow, no Private Networking).
4. Create a Neon branch snapshot of production before anything else.

**Phase 1 — staging spike (2–3 d, throwaway-able)**
1. Enable Managed Better Auth on the **staging branch**; capture base URL + cookie secret into the
   `staging` GitHub Environment / Vercel scope.
2. Land `lib/auth/server.ts`, `app/api/auth/[...path]/route.ts`, `proxy.ts`, and a `currentUser()`
   that reads the Neon session and JIT-links/creates our `users` row via a new `auth_user_id` column.
3. Keep `AUTH_PROVIDER=local` as the default so nothing changes for existing sessions.
4. Prove: sign-up, sign-in, sign-out, session persistence, role gating (`/admin`, `/usage-guide`),
   Stripe checkout with a Neon-authenticated user, password reset, email verification.
5. Run the full test/verifier suite; fix the seeders to mint auth users.

**Phase 2 — cutover on staging (1–2 d)**
1. Flip `AUTH_PROVIDER=neon` for staging only; force reset (if users exist); announce.
2. Add auth assertions to `deploy.sh`/CI smoke: sign-up → sign-in → `/api/health` → `/dashboard`.
3. Burn in ~1 week; write ADR 006 ("Auth provider and identity ownership") and update
   `docs/setup/env-templates.md`, `01-foundation-and-deployment.md`, `AGENTS.md`.

**Phase 3 — production (1–2 d + burn-in)**
1. Owner-only: enable auth on the production branch, register trusted domains, set SMTP, store secrets
   per environment (Vercel Production scope only).
2. Migrate schema (drop `sessions`, `password_hash` nullable, `auth_user_id` + index) **after** the
   code that no longer needs them is deployed on staging.
3. Flip the flag; smoke sign-up/sign-in/checkout/PDF; watch logs for 24 h.
4. Remove the local-auth branch (delete `passwords.ts`, `createSession`) one milestone later if clean.

**Phase 4 — follow-ups (not blocking)**
MFA when Neon ships it, OTP/magic-link for mobile, admin user management, rate limiting,
`/api/ready` tie-in, and the #16 validation checklist items (MFA, rate-limit, CSRF) that Auth
partially satisfies.

---

## 7. Cheaper alternative (worth considering before you commit)

If the goal is only *"stop shipping broken auth"*, the shortest path is **not** a provider migration:

- Fix #52 (a day, mostly operations), then spend **2–3 days** adding what our auth is actually missing:
  password reset (token table + 2 routes + email), email verification, and login rate limiting.
- That is ~1/3 of the Neon Auth effort, uses zero new vendors, and keeps existing passwords working.
- Choose Neon Auth when you want **OAuth/OTP/MFA on the roadmap**, want auth state to branch with the
  database, and want to delete our crypto code — accepting forced resets and vendor coupling.

Recommendation: do the **#52 fix regardless**, decide between "thin local auth hardening" and
"Neon Auth" with the zero-users fact in hand. If production has no real accounts, migrating costs
almost nothing and buys the most.

---

## 8. Sources

- Neon — About Managed Better Auth: <https://neon.com/docs/auth/about>
- Neon — Managed Better Auth roadmap: <https://neon.com/docs/auth/roadmap>
- Neon — Next.js (API-only) quick start: <https://neon.com/docs/auth/quick-start/nextjs-api-only>
- npm — `@neon/auth` 0.8.2 (published 2026-10-30); legacy `@neondatabase/auth` 0.7.0-beta
