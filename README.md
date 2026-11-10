# Solara

A bilingual solar-return prototype with Stripe subscriptions, city search and map selection, private editorial PDFs, and role-based content editing.

## Setup and deployment guides

Start with the [setup guide index](docs/setup/README.md), or in development (`npm run dev`) open `/setup` in the running application for a bilingual, environment-specific checklist. Detailed guides cover local development, staging and production for:

- [Foundation, PostgreSQL, CI/CD and deployment](docs/setup/01-foundation-and-deployment.md)
- [Stripe Checkout, webhooks, subscriptions and MXN/USD pricing](docs/setup/02-stripe.md)
- [Geocoding and map tiles](docs/setup/03-geocoding-and-maps.md)
- [Editorial PDF downloads](docs/setup/04-pdf.md)
- [English and Spanish](docs/setup/05-i18n.md)
- [Solar-return calculations and house systems](docs/setup/06-astrology-and-houses.md)

## Internal documents and usage guide

The routes `/blueprint` and `/setup` are available only in development (`npm run dev`). Outside development each returns 404 and its header, footer, and dashboard links are hidden — the blueprint-only footer column is removed and the footer grid compacts accordingly.

The route `/usage-guide` is open in development (all six role guides are rendered and `?role=` overrides the active audience for preview). Outside development it is scoped to the signed-in user: a signed-in user sees exactly one guide matching their real role (email `user` → `free`/`premium` via subscription, `editor`/`admin`/`owner` by role; `?role=` is ignored), an anonymous user receives 404, and no other role content is included in the HTML or RSC payload. Internal `/setup` and `/blueprint` section links inside the guide are also hidden outside development.

### Usage guide

Run the application with `npm run dev` and open `/usage-guide` to explore the bilingual, role-by-role handbook. It covers visitors, free and Premium customers, editors, admins, and owners; selecting a guide does not grant permissions.

## Quick local start

Use Node.js 22 and a **new, empty, disposable** PostgreSQL database. Configure `DATABASE_URL` and `APP_URL` in `.env` (copy `.env.example` only if `.env` does not already exist), then run `npm ci`, `npx drizzle-kit migrate`, and `npm run dev`. Run `node scripts/check-setup.mjs local` for a secret-safe format check.

Earlier prototypes may have databases created with `drizzle-kit push` and no migration history. Do not run the initial migration blindly on those databases; use a fresh development database or obtain a reviewed baseline. Never use `push` against production. The CI workflow applies versioned migrations to a disposable database, runs `npm run db:check`, and runs `RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts`. `/api/health` is liveness only; `/api/ready` is the deployment gate. See ADR 008 for the migration and rollback policy.

Public registration creates a free user. A trusted operator must provision the first owner; see the foundation guide. No Stripe keys, prices or customer data are included.

## Browser autofill compatibility

Personal fields use named, standard autocomplete tokens for supported browsers. As a temporary mitigation for reported Brave autofill crashes, the app asks Brave not to autofill profile fields; password fields still use `new-password` and `current-password`. Search, location and editorial fields explicitly opt out of profile autofill. Browser autocomplete is a hint and may be ignored, so this is not a guaranteed fix for a browser-process bug. Test the affected Brave release and, if it still crashes, update Brave or disable the “New Alias” hint in Brave's Email Aliases settings. See [Brave issue #60126](https://github.com/brave/brave-browser/issues/60126).

## Launch limitations

This is not yet production-ready. Calculations and historical time zones require independent professional validation; Placidus is not implemented. Account claim by mailbox proof, password reset, auth rate limiting, structured logging, `/api/places` hardening, explicit database pool/TLS settings, strict origin checks and security headers are implemented, with CSP in report-only mode until a clean observation window. Staff MFA, report-version snapshots, editorial approval, privacy/consent operations and other controls remain launch work. Review provider licensing, tax and billing policies, dependencies, backups and incident procedures before accepting real customers.
