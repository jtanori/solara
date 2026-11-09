# Solara setup guides

These guides cover the current application in three separate environments. The compact bilingual checklist is also available inside the application at `/setup` when running in development (`npm run dev`). Outside development `/blueprint` and `/setup` each return 404 (gated by runtime `NODE_ENV === "development"`), and their header, footer, and dashboard links are hidden — the blueprint-only footer column is removed and the grid compacts. The route `/usage-guide` is role-scoped outside development: anonymous users receive 404 and signed-in users see exactly one guide for their real role (`?role=` is ignored, no other role content in the payload; internal `/setup`/`/blueprint` section links are hidden).

1. [Foundation, database, CI/CD and deployments](01-foundation-and-deployment.md)
2. [Stripe subscriptions and MXN/USD pricing](02-stripe.md)
3. [Geocoding and map selector](03-geocoding-and-maps.md)
4. [Editorial PDF downloads](04-pdf.md)
5. [English and Spanish](05-i18n.md)
6. [Solar-return calculation and house systems](06-astrology-and-houses.md)
7. [Platform validation checklist](07-platform-validation.md)
8. [Auth and security hardening](08-auth-security-hardening.md)
7. [Platform validation checklist — pre-launch gate](07-platform-validation.md) *(owners + evidence)*

## Recommended environment separation

| | Local | Staging | Production |
|---|---|---|---|
| App | Node.js 22 on localhost | Vercel Preview, dedicated `staging` branch/domain | Vercel Production, protected `main` branch/domain |
| Database | Disposable local PostgreSQL | Separate managed PostgreSQL | Separate managed PostgreSQL with backups and restore drills |
| Stripe | Test mode + Stripe CLI | Test mode + staging webhook | Live mode + separate production webhook |
| Maps | Public services for evaluation | Isolated test configuration | Appropriate commercial geocoding and tile-provider agreement |
| Data | Synthetic only | Synthetic only | Real data only after launch approval |

A single Vercel project with branch-specific Preview variables is the recommendation; a custom staging environment on eligible plans or two isolated projects are valid alternatives. Never use production secrets or customer data in Preview deployments.

## Common prerequisites

- Node.js 22, npm, Git and PostgreSQL 16 or later. Install the Stripe CLI for local billing tests.
- Copy `.env.example` to `.env` **only if `.env` does not already exist**. Fill in values locally; never commit real keys. `.gitignore` protects new environment files, but it does not remove secrets already tracked by Git—remove and rotate any previously exposed secret.
- `DATABASE_URL` is required by the app and Drizzle. `APP_URL` should be the canonical origin. Stripe values are needed only to activate billing. Optional map and commercial geocoding settings are documented in the map guide.
- Local email defaults to `MAIL_TRANSPORT=outbox` and writes `.mail-outbox/*.eml`; staging/production require a Resend or Postmark provider. Security headers and CSP rollout are documented in [08-auth-security-hardening](08-auth-security-hardening.md).
- Next.js loads its normal environment files; `drizzle.config.ts` and `scripts/check-setup.mjs` load `.env` via dotenv and also honor already-exported variables. Do not assume `.env.local` is loaded by those two commands; export the intended variables in a secure shell or runner.
- Run `node scripts/check-setup.mjs local` for a format-only check that never prints values. Use `staging --strict` or `production --strict` in a secure environment after configuration. This does **not** verify credentials, licensing, webhook delivery, data isolation, or readiness for launch.

## Important launch gate

The app is a prototype, not yet ready for real customer data or live billing. Before production, complete independent astronomical and historical-time-zone validation; password recovery; staff MFA; CSP enforcement after the observation window; privacy/consent, export and retention processes; editorial review and report versioning; tested backups, monitoring and incident response; tax, refund and cancellation policies; provider terms and a security review. Do not treat a successful build or configuration check as launch approval.
