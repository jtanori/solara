# 7. Platform validation checklist — pre-launch gate (ADR 003 / #16)

> **Status:** `prototype` — `main` is on Vercel Production but is **not** approved for real customer data or live billing. Every item below must be **owned, evidenced, and marked `pass`** before a production launch with real data. Building green (`verify` + `check-setup.mjs`) is **not** launch approval.

Source: `docs/decisions.md` ADR 003 + ADR 005, `README.md` § Launch limitations, `docs/setup/06-astrology-and-houses.md`. Track work in GitHub Issues; this file is the evidence index.

## How to use

| Field | Meaning |
|---|---|
| **Owner** | GitHub handle responsible for producing evidence |
| **Evidence** | File, fixture, dashboard link, or test that proves the item |
| **Status** | `todo` / `in-progress` / `pass` / `waived` |

Move an item to `pass` only when its evidence is committed or linked and a reviewer has commented `verified` on the PR. Keep `BACKLOG.md` and the relevant `docs/setup/*` guide in sync.

---

### 1. Astronomical calculations

| # | Item | Owner | Evidence | Status |
|---|---|---|---|---|
| 1.1 | Agree zodiac, reference frame, ephemeris (Astronomy Engine vX.Y.Z), precision, and tolerance with reviewer | @astro-reviewer | `docs/setup/06-astrology-and-houses.md` + comment on #16 | todo |
| 1.2 | Independent fixture set: leap-day, year-boundary birthdays, DST gap/fold (spring-forward / fall-back), southern-hemisphere, historical TZ transitions | @astro-reviewer | `tests/solar.test.ts` fixtures + `docs/setup/fixtures/solar-return/*.json` (new) | todo |
| 1.3 | Tolerance report: UTC instant ≤ 60s, Ascendant/house placement within documented tolerance vs. reference (e.g., Swiss Ephemeris or published tables) | @astro-reviewer | `docs/setup/06-astrology-and-houses.md` § Production setup + PDF report | todo |
| 1.4 | Version pinning: engine, TZ data (IANA), and map boundaries recorded per report | @infra | `package.json` + `package-lock.json` + report header | todo |

> Placidus is **not** implemented; whole-sign only. High absolute latitude ≥66° omits Ascendant/houses pending verification — see `src/app/blueprint` logic.

### 2. Historical time zones, leap years, high latitudes

| # | Item | Owner | Evidence | Status |
|---|---|---|---|---|
| 2.1 | Daylight-saving gaps (non-existent local time rejected) and folds (caller picks earlier/later) covered by tests | @eng | `tests/solar.test.ts` DST cases | pass (regression, needs independent validation) |
| 2.2 | Pre-1970 and post-1970 zone changes validated against IANA DB for sample birthplaces (e.g., Sonora, US/EU) | @astro-reviewer | fixture pack + report | todo |
| 2.3 | High-latitude omissions (≥66°) documented in UX and not shown as valid houses | @design | `/blueprint` copy + test | todo |

### 3. Editorial, professional review, and report versioning

| # | Item | Owner | Evidence | Status |
|---|---:|---|---|---|
| 3.1 | All `/blueprint` / `/setup` / `/usage-guide` copy reviewed by domain owner; sign-off recorded | @content | GitHub Review `verified` + PDF snapshot | todo |
| 3.2 | Report versioning: engine + inputs + TZ DB + content version stored per generated report; immutable snapshot restorable | @eng | `drizzle` table + migration + test | todo |
| 3.3 | Editorial approval workflow (draft → review → publish) documented | @content | `docs/setup/04-pdf.md` | todo |

### 4. Backup / restore, monitoring, incident response

| # | Item | Owner | Evidence | Status |
|---|---:|---|---|---|
| 4.1 | Neon prod: automated backups + PITR enabled; branch restore drilled into isolated project | @infra | Neon dashboard screenshot + `docs/setup/01-foundation-and-deployment.md` drill log | todo |
| 4.2 | Vercel logs, DB connection/pool, webhook retry, and PDF timing alerts with owner + runbook | @infra | Vercel + Neon alert config + `01-foundation` § Operational checklist | todo |
| 4.3 | Incident response plan (who pages, rollback steps, comms) documented and tested | @infra | `docs/setup/01-foundation-and-deployment.md` rollback section | todo |
| 4.4 | Liveness and readiness separated; `/api/ready` covers DB/schema/migrations/auth with a bounded probe; deploy fails closed | @infra | `src/app/api/health/route.ts`, `src/app/api/ready/route.ts`, `src/lib/readiness.ts`, `scripts/deploy.sh` | in-progress |

### 5. Security and privacy controls

| # | Item | Owner | Evidence | Status |
|---|---:|---|---|---|
| 5.1 | Email verification on signup (prevent stale/typo owners) | @eng | Mailbox-proof account claim: `src/lib/email-verification.ts`, `src/lib/auth-service.ts`, `tests/email-verification.test.ts`, `tests/auth-endpoint.test.ts`, `/verify-email`; PR #118 | in-progress |
| 5.2 | Password recovery flow | @eng | `src/lib/email-verification.ts`, `src/lib/auth-service.ts`, `tests/password-reset.test.ts`, `/forgot-password`, `/reset-password` | in-progress |
| 5.3 | Staff MFA for `admin`/`owner` (and rate-limited owner promotion) | @eng | `src/lib/billing.ts` + Neon RLS + docs | todo |
| 5.4 | Rate limiting on `/api/auth` and `/api/billing/*` | @eng | `src/lib/rate-limit.ts`, `tests/rate-limit.test.ts`, `tests/auth-endpoint.test.ts`, `npm run rate-limits:report`; auth endpoints covered, billing follow-up | in-progress |
| 5.5 | Full CSRF strategy for cookie-authenticated POSTs (not just Next.js defaults) | @eng | `src/proxy.ts`, `src/lib/request-security.ts`, `tests/request-security.test.ts`; full-origin + `/api/:path*` matcher | in-progress |
| 5.6 | Data retention / export / deletion (GDPR-style) + privacy notice | @content/@eng | `docs/setup/README.md` + legal page | todo |
| 5.7 | Secrets hygiene: no `DATABASE_URL` in logs, Vercel env separation verified (`check-setup.mjs --strict` + `check-remote-setup.mjs`) | @infra | `scripts/check-remote-setup.mjs` output | pass (tooling) |
| 5.8 | Dependency / vulnerability alerts: Dependabot PRs + GitHub Alerts enabled, first run verified | @infra | `settings → Code security` screenshots + PRs #24-35 | in-progress |

---

## Current evidence summary (2026-11-07)

- **Pass (tooling only):** 2.1 regression, 5.7 secrets hygiene — CI `verify` includes `next typegen`, `tsc`, `eslint`, `tests`, `audit`, `build` + smoke 404s for internal-doc gating.
- **In-progress:** 5.1 mailbox-proof account claim, 5.4 auth rate limiting, 5.5 strict full-origin/CSRF — implemented on `feat/53-54-56-57-auth-security-hardening` with unit/integration tests and staging verification pending. Billing rate limiting remains a follow-up under 5.4.
- **In-progress:** 5.8 — ` .github/dependabot.yml` (npm + github-actions, `target-branch: staging`, weekly Mon 09:00 America/Hermosillo, limits 10/5) landed in #20; 12 Dependabot PRs #24-35 are open on `staging` = first run succeeded. Repo toggle `Dependabot alerts` + `Dependabot security updates` must be enabled in `Settings → Code security` (requires owner UI click — cannot be done via `GITHUB_TOKEN`); verify with `gh api repos/jtanori/solara/dependabot/alerts` → 200 when enabled.
- **Todo:** owner assignment for every `todo` above — set in the next refinement of #16.

Before any `main` deploy with live Stripe or real birth data: all rows must be `pass` and reviewed on a PR that targets `staging` → `main` via `scripts/deploy.sh`.

References: `BACKLOG.md` #16, `docs/decisions.md` ADR 003/005, `AGENTS.md` §3 Security Invariants.
