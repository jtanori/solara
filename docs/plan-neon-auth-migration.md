# Plan — Neon Auth migration (revised decision document)

**Status:** **PENDING DECISION** — the current auth is under security review (§2). Do not start
migration work until §2's verdict and the §3 gate are settled.
**Supersedes:** the first-pass assessment (`docs/auth-neon-assessment.md`) — that file is now the
research appendix; this file is the plan of record.
**Prerequisite:** [#52](https://github.com/jtanori/solara/issues/52) must be closed. Auth tables in a
database that never receives migrations are just as invisible as `public.users` is today.
**Date:** 2026-11-08 · **Branch:** `arena/8f0da984-solara`
**Issues:** gaps S1–S10 are filed as #53 (S1), #54 (S3/S4), #55 (S2), #56 (S7), #57 (S8), #58 (S9), #67 (S5), #68 (S6), #69 (S10) — see #73 for the epic and launch gate.

---

## 1. Decision summary

| | |
|---|---|
| **Question** | Do we keep our own email/password auth, or move identity to Neon Managed Better Auth? |
| **Current recommendation** | **Keep local auth, harden it — for launch.** Re-evaluate Neon Auth after launch, or immediately if any of §3's triggers fire. |
| **Why not now** | (a) Our own auth has real gaps, but they are *shippable gaps*, not architectural dead ends; (b) Neon Auth costs ~7 dev days + forced password resets + a young vendor dependency, and would be adopted **to solve problems we can fix in 3 days**; (c) security-critical migration is the worst thing to do while the deploy pipeline is unproven (#52 just proved that). |
| **What would flip it** | A trigger in §3 (e.g. we need OAuth/MFA/multi-device sessions soon, or the local hardening effort balloons past ~5 days). |
| **Non-negotiable either way** | No public launch until §2's "must fix before launch" list is done. Today the app says so itself in `/blueprint` and `README.md`. |

---

## 2. Security review of the current auth (the thing to settle first)

Verdict: **the cryptography and session handling are sound; the operational surface around them is
not.** Concretely, in code (`src/lib/passwords.ts`, `src/lib/auth.ts`, `src/app/api/auth/route.ts`):

### 2.1 What is correct (do not "fix" these)

| Control | Implementation | Assessment |
|---|---|---|
| Password hashing | `scryptSync(password, salt, 64)` with `node:crypto` defaults (N=16384, r=8, p=1), 16-byte random salt, hex-encoded | **Correct algorithm and parameters** (memory-hard, ~16 MB/32 ms). Not bcrypt, not a home-made KDF. |
| Comparison | `timingSafeEqual` + strict hex/length validation | **Correct** (constant-time, no truncation surprise). |
| Password transport | `POST` JSON over HTTPS, `httpOnly` cookie response, never logged, never stored in the cookie | **Correct.** Passwords never appear in URLs, logs, or the session cookie. |
| Minimum password policy | ≥ 10 chars (server-enforced) + max 128 + email regex | Acceptable for launch (NIST-friendly: length over composition rules). |
| Session token | 32 random bytes (`randomBytes(32).toString("base64url")`), **only its SHA-256** stored in `sessions` | **Correct design** — a DB leak does not yield usable cookies (256-bit token, no rainbow table). |
| Cookie flags | `httpOnly`, `SameSite=Lax`, `Secure` in production, `path=/`, server-set expiry + DB expiry | **Correct.** No JS access, no cross-site POSTs. |
| Enumeration on login | identical "email or password is incorrect" response | **Correct.** |
| Authorization | server-side role checks (`canManageUsers`, `canEditKnowledge`), ownership checks on readings/PDFs, audit rows on role/knowledge changes, owner-protected self-deletion | **Correct** and better than most prototypes. |
| Session fixation | session row created post-auth with a fresh token | **Correct.** |

### 2.2 Gaps — "must fix before public launch"

| # | Gap | Why it matters | Fix (local) |
|---|---|---|---|
| S1 | **[#53](https://github.com/jtanori/solara/issues/53)** — **No rate limiting, lockout, or CAPTCHA on `/api/auth`** | Unlimited password guessing is viable against a *known email* — the very thing the enumeration-resistant message hides. Also enables account-spam sign-ups and scrypt CPU exhaustion (each attempt costs 16 MB + ~30 ms) | Token-bucket per IP + per email in Postgres (or Upstash), exponential backoff, 429 with `Retry-After`; optional Turnstile on signup |
| S2 | **[#55](https://github.com/jtanori/solara/issues/55)** — **No password reset** | Users who forget their password are permanently locked out (support burden + churn). The UI admits this. | `password_reset` table (hashed token, 1 h TTL, single use) + `POST /api/auth/reset/request` & `/confirm` + email provider |
| S3 | **[#54](https://github.com/jtanori/solara/issues/54)** — **No email verification** | Anyone can register someone else's email; no proof of ownership; no channel for S2 | `email_verified_at` + signed token + resend endpoint (same transport as S2) |
| S4 | **[#54](https://github.com/jtanori/solara/issues/54)** — **No email transport at all** | Blocks S2, S3, and account notifications | Pick one (Resend/SES/Postmark), add a single `sendMail()` seam |
| S5 | **[#67](https://github.com/jtanori/solara/issues/67)** — **No password change** (email is read-only, name only) | A leaked password cannot be rotated by the user | `POST /api/auth/password` requiring current password |
| S6 | **[#66](https://github.com/jtanori/solara/issues/66)**, **[#68](https://github.com/jtanori/solara/issues/68)** — **No global revocation** — logout deletes one token, there is no "sign out everywhere", expired rows are never purged | Stolen cookie cannot be revoked globally; `sessions` grows forever | `sessions` already keyed per token: add `signOutAll` (delete by `user_id`) and a periodic purge of expired rows |
| S7 | **[#56](https://github.com/jtanori/solara/issues/56)** — **`sameOrigin()` allows a missing `Origin` header** (`if (!origin) return true`) | CSRF defence relies on browsers always sending `Origin` on `POST`. Practical risk is low (SameSite=Lax blocks cross-site POSTs), but it is defence-in-depth that silently degrades | Require `Origin` (or `Sec-Fetch-Site: same-origin`) on state-changing routes |
| S8 | **[#57](https://github.com/jtanori/solara/issues/57)** — **No security headers** — no CSP/HSTS/`X-Frame-Options`/`Referrer-Policy`, no `middleware.ts` | Clickjacking, downgrade, and referrer leakage are unmitigated; Next has first-class support for this | `headers()` in `next.config.ts` (or a `proxy.ts` in Next 16) with a strict CSP |
| S9 | **[#58](https://github.com/jtanori/solara/issues/58)** — **No MFA for staff (owner/admin)** | An admin account compromise = full control of roles and knowledge content | TOTP (`otplib`-style) + recovery codes, enforced by role |
| S10 | **[#69](https://github.com/jtanori/solara/issues/69)** — **No session rotation / idle timeout** | 30-day absolute session with no re-auth for sensitive actions (role change, account deletion, password change) | Re-auth (password prompt) before sensitive mutations; optional 7-day idle cap |

### 2.3 Not a gap (call out explicitly so it is not re-litigated)

- **No third-party auth dependency** = no vendor-side token, no per-branch auth state to misconfigure,
  no beta churn while the product is still finding its shape.
- **Hashes are ours**, so a future migration to any provider can be planned on our schedule rather than
  forced by a provider change.
- scrypt with default parameters is **acceptable today**; if we keep local auth long-term, bump to
  `N=2^17` with a versioned hash prefix (`v2$…`) so parameters can evolve (nice-to-have, not a gap).

### 2.4 Verdict

**Reliable: yes** (session model, token handling, cookie flags, authorization are all conventional and
correct). **Secure enough to launch today: no** — S1–S4 are launch blockers, S5–S10 are launch-week
work. **All ten are fixable in our own code in ~3 days**, with no dependency risk.

---

## 3. Go / no-go gate for Neon Auth

Adopt Neon Auth **only if** at least one is true:

1. **Product needs** OAuth (Google/Apple), magic links/OTP, or multi-tenant organizations **within the
   next 2 months** — building those ourselves costs more than the migration.
2. **MFA for users** (not just staff) becomes a requirement before we can afford to build it.
3. **Team capacity:** we can dedicate ~1 week of focused work **and** accept a forced password reset
   for all users.
4. Local hardening (S1–S4) is estimated to cost **more than 5 days** once started — i.e. the local path
   is not actually cheaper.

Otherwise: harden locally, revisit after launch. **Do not run both paths in parallel** — parallel auth
implementations are how identity bugs happen.

---

## 4. If we go: decisions to lock before writing code

| # | Decision | Recommendation | Rationale |
|---|---|---|---|
| D1 | Identity ownership | **Hybrid:** `neon_auth.user` is the credential; our `public.users` stays the domain record, linked by `auth_user_id uuid unique` (or an `auth_subject text unique`) | `subscriptions`, `readings`, `audit_logs`, and Stripe customer mapping all FK to `users.id`; rewriting them buys nothing |
| D2 | Existing passwords | **Forced reset**, unless #52's triage finds real accounts *and* we want a bridge; then dual-verify for ≤60 days | scrypt `saltHex:hashHex` is not portable into Better Auth's hasher config |
| D3 | `sessions` table | **Drop in a migration after** the cutover has burned in for a week | keeps rollback cheap |
| D4 | `users.id` / PKs | **Keep UUID PK**, add nullable `auth_user_id` first (expand), backfill via JIT link on next sign-in, make NOT NULL later (contract) | expand/contract, no downtime |
| D5 | `password_hash` | Make **nullable** before cutover; drop one milestone later | keeps the local path reversible |
| D6 | Roles | Keep our `owner/admin/editor/user` in `public.users`; **do not** adopt Better Auth's admin roles | app permissions already implemented and tested |
| D7 | Client wiring | Proxy everything through our app: `app/api/auth/[...path]/route.ts` + `createNeonAuth()`; block admin endpoints at the route layer | first-party cookies, no CORS/trusted-domain churn, one place to audit |
| D8 | Environments | One auth instance **per Neon branch**; production must have its own `NEON_AUTH_BASE_URL` + cookie secret + trusted domains (`solara-production.vercel.app`, custom domain) | the #52 lesson: per-env config drifts silently |
| D9 | Email | Custom SMTP before real users; Neon's default mailer only for staging | deliverability, branding, reset flow reliability |
| D10 | Rollback | `AUTH_PROVIDER=local\|neon` env flag for one milestone; both paths must be able to read the same `users` row | reversible until proven |
| D11 | Preview branches | Auth **disabled** on PR previews unless explicitly enabled | avoids stray identity stores and cost |

Regional/plan constraints to verify **before** committing: Managed Better Auth is **AWS-only** and
unavailable on projects with **IP Allow** or **Private Networking** enabled.

---

## 5. If we go: phases, effort, risks

### 5.1 Phases

| Phase | Scope | Exit criteria | Effort |
|---|---|---|---|
| **0. Prereqs** | #52 closed (schema actually applied, `/api/health` schema-aware); `select count(*) from users` recorded; Neon project satisfies AWS/no-IP-Allow; production branch snapshot | Evidence posted on #52 | 0.5 d |
| **1. Staging spike** | enable auth on the staging branch; `lib/auth/server.ts`; catch-all route; `proxy.ts`; `currentUser()` reads Neon session and JIT-links `users`; keep `AUTH_PROVIDER=local` | full pass on staging: signup, signin, signout, reset, verify, role gating, Stripe checkout with a Neon-authenticated user | 2–3 d |
| **2. Staging cutover** | flag → `neon`; forced reset if users exist; auth smoke in `deploy.sh`/CI (`signup → signin → /api/health → /dashboard`) | 1 week clean on staging; ADR 006 written | 1–2 d + burn-in |
| **3. Production** | enable on prod branch, trusted domains, SMTP, secrets scoped to Production; expand/contract schema (add `auth_user_id`, null `password_hash`), then drop `sessions` | prod signup/signin/checkout/PDF verified; 24 h clean logs | 1–2 d |
| **4. Cleanup** | delete `passwords.ts`/session helpers/`AUTH_PROVIDER`; drop `password_hash` | one milestone later, if clean | 0.5 d |

**Total: ~6–9 dev days + 1 week of burn-in.**

### 5.2 Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Forced password reset alienates users | High if users exist | Churn | Only viable while the user base is tiny — which is the *argument for doing it now or never* |
| Vendor youth: `@neon/auth` first published 2026-10-08; docs/package names changed within weeks; MFA still "coming soon" | Medium | Rework, surprises | Pin an exact version, isolate behind `lib/auth/server.ts`, never query `neon_auth` tables directly |
| Per-environment misconfiguration (`NEON_AUTH_BASE_URL` from staging in production) | Medium | Cross-environment identity | Explicit env matrix + `check:setup` assertion comparing branch/host per env |
| Auth tables live in `neon_auth` → our schema gate could miss them | High if #52's fix is shallow | Silent repeat of this incident | Add `to_regclass('neon_auth.user')` to the readiness probe |
| Session cutover logs everyone out | Certain | UX | Low-traffic window + communication |
| Cookie/domain/trusted-domain mistakes | Medium | Silent login failure | Register every real host, test both envs explicitly, keep `verify-full` TLS |
| Lock-in to Neon branching/region | Low–Medium | Future exit cost | D1 (own users table) + documented export path from `neon_auth` |
| Beta→GA schema changes in `neon_auth` | Low (GA) | Migration churn | SDK-only access, pin version |
| Security review of a managed identity service | Low | Compliance time | Same region/project, document in ADR + privacy page |

---

## 6. If we don't go: local hardening plan (the recommended path)

Ship in this order; each item is independently deployable.

### Sprint A — make it safe to open sign-up (≈1.5 d)
1. **S4** email seam (`sendMail()` + provider key in env, no-op in dev).
2. **S3** email verification (token table, resend, `email_verified_at`; gate premium/checkout until verified).
3. **S2** password reset (request/confirm, single-use, 1 h TTL, no user enumeration).
4. **S1** rate limiting (DB or Upstash token bucket on `/api/auth` + reset endpoints; 429 + `Retry-After`).
5. **S8** security headers (CSP, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`).

### Sprint B — harden the existing surface (≈1 d)
6. **S5** password change (current password required, rotates all sessions).
7. **S6** `signOutAll` + expired-session purge.
8. **S7** strict `Origin`/`Sec-Fetch-Site` check on state-changing routes.
9. **S10** re-auth before role change / account deletion; optional idle timeout.

### Sprint C — staff + operations (≈0.5–1 d)
10. **S9** TOTP MFA for `owner`/`admin` (+ recovery codes, enforced by role).
11. Audit-log viewer or export (roles changes are already recorded, not visible).
12. Token-hash parameter versioning (`v2$` prefix) so scrypt cost can be raised later.

**Total ≈3–3.5 days**, zero new vendors, no forced resets, no lock-in. Then re-run §3's gate.

---

## 7. What changes either way (shared groundwork)

| Work | Why it is useful regardless |
|---|---|
| Readiness probe incl. auth tables | Both paths need "auth works" as a deploy gate |
| `users` table as domain record + `auth_user_id` column | Optional but harmless; makes a later migration a flag flip rather than a schema rewrite |
| Email transport seam | Needed by reset/verification (local) or by Neon Auth (SMTP) |
| Role/authorization tests around `currentUser()` | Keep the 18 call sites behaviour-compatible in both worlds |
| ADR 006 "identity & credential ownership" | Records *why*, whichever way we go |

---

## 8. Open questions for you

1. Do you want OAuth / magic links / user-facing MFA in the next 2 months? (If yes → the gate in §3
   likely flips toward Neon Auth.)
2. Are there **real accounts in production** today? (Decides whether a forced reset costs anything —
   #52's triage answers it.)
3. Is there appetite for a ~3-day local hardening sprint **before** launch, or a ~7-day provider
   migration **after** #52 is closed?
4. Who owns email deliverability (a domain + sending provider), since both paths need it?

## 9. Sources / appendix

- Research detail (product limits, SDK shape, pricing, package versions): `docs/auth-neon-assessment.md`
- Neon — About Managed Better Auth: <https://neon.com/docs/auth/about>
- Neon — roadmap: <https://neon.com/docs/auth/roadmap>
- Neon — Next.js API-only quick start: <https://neon.com/docs/auth/quick-start/nextjs-api-only>
- `@neon/auth@0.8.2` (published 2026-10-30) vs legacy `@neondatabase/auth@0.7.0-beta`
