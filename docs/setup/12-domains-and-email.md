# Domains and transactional email

Canonical origins for the two hosted environments:

| Environment | Canonical origin | Vercel target | Sender |
|---|---|---|---|
| Production | `https://www.thanatos.mx` | Production (`main`) | `Solara <no-reply@thanatos.mx>` |
| Staging | `https://staging.thanatos.mx` | Preview, Git branch `staging` | `Solara <no-reply@thanatos.mx>` |
| Apex | `https://thanatos.mx` | 308 redirect to `www` | — |

`info@thanatos.mx` is the human inbox and stays the **reply-to**. It is not the sender.

## Why the order matters

`APP_URL` is the canonical origin used for email links, password reset, Stripe
return URLs, the mutation-origin allowlist (`src/proxy.ts` via
`src/lib/request-security.ts`) and CSP. Flipping it before the hostname resolves
with a valid certificate breaks those flows. Do the work in this order:

1. Vercel domains and DNS → TLS ready.
2. Resend domain verification → the sender can actually deliver.
3. Vercel environment variables → redeploy.
4. Stripe webhook endpoint (see the end) → re-copy the signing secret.
5. Smoke tests.

Keep the current `*.vercel.app` origin as a fallback at every step. Nothing here
requires downtime for the running deployment.

---

## 1. Vercel custom domains

Dashboard (recommended, because branch scoping is UI-only):

1. **Project → Settings → Domains → Add**
   - `www.thanatos.mx` → environment **Production**; make it the primary domain.
   - `thanatos.mx` → **Production**, then **Edit → Redirect to** `www.thanatos.mx` (308). Sessions use host-only cookies, so both hosts must not serve the app.
   - `staging.thanatos.mx` → **Preview** → **Git branch** `staging`.
2. Vercel shows the required DNS values per domain. Add them at the DNS provider
   (next section), then return and confirm each domain shows **Valid Configuration**.

CLI equivalent for the account-level records (attaching a domain to the project
and selecting the branch still happens in the dashboard):

```bash
vercel domains add thanatos.mx
vercel domains add www.thanatos.mx
vercel domains add staging.thanatos.mx
vercel domains inspect www.thanatos.mx   # nameservers/records and verification state
```

Do not paste the values Vercel prints into chat or a ticket if they include a
verification TXT for a domain you do not own yet.

## 2. DNS records for Vercel

| Type | Name | Value | Notes |
|---|---|---|---|
| `A` | `@` (`thanatos.mx`) | `76.76.21.21` | Apex. Use `ALIAS`/`ANAME` instead if the provider supports it. |
| `CNAME` | `www` | `cname.vercel-dns.com` | Production primary. |
| `CNAME` | `staging` | `cname.vercel-dns.com` | Staging Preview branch. |

- **Cloudflare:** set these records to **DNS only** (grey cloud). Proxying Vercel
  through Cloudflare adds a second TLS terminator and breaks the certificate
  flow Vercel expects.
- **Registrar without `ALIAS` support:** the apex `A` record above is the
  supported path; the redirect to `www` is configured in Vercel, not at the
  registrar.
- Leave any existing `MX`, `SPF`/`TXT` and `DKIM` records for `info@thanatos.mx`
  untouched. Resend's records live on the `send` subdomain (below), so the
  mailbox provider keeps working.

Verify from a machine outside the Vercel network:

```bash
dig +short www.thanatos.mx
dig +short staging.thanatos.mx
dig +short thanatos.mx
curl -sSI https://www.thanatos.mx | head -5
curl -sSI https://staging.thanatos.mx | head -5
```

`www` and `staging` should resolve to Vercel, and both should answer with a
valid certificate (`curl` fails with a TLS error otherwise). `staging` is a
Preview deployment and stays behind Vercel Authentication; that is expected.

## 3. Resend

1. **Domains → Add Domain → `thanatos.mx`.** Verify the root domain, not
   `send.thanatos.mx`; the app sends `From: …@thanatos.mx`, and Resend's
   Return-Path/SPF records are placed on the `send` subdomain automatically, so
   the mailbox MX at the root is not disturbed.
2. Copy the records **exactly as the dashboard shows them** (region and DKIM key
   vary per account):

   | Type | Name | Value | Purpose |
   |---|---|---|---|
   | `MX` | `send.thanatos.mx` | `feedback-smtp.<region>.amazonses.com` (priority 10) | Return-Path / bounces |
   | `TXT` | `send.thanatos.mx` | `v=spf1 include:amazonses.com ~all` | SPF for the sending subdomain |
   | `TXT` | `resend._domainkey.thanatos.mx` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ…` | DKIM |
   | `TXT` | `_dmarc.thanatos.mx` | `v=DMARC1; p=none; rua=mailto:info@thanatos.mx; fo=1` | Monitoring first |

   Never add a **second** `SPF` record at the root. If the mailbox provider
   already publishes one, Resend's belongs only on `send`.
3. Back in Resend, click **Verify** and wait for all records to show verified.
4. **API Keys → Create API Key**, permission **Sending access**, restricted to
   `thanatos.mx`. Create one per environment (`solara-production`,
   `solara-staging`) so either can be revoked alone. The key is shown once.
5. Optional: send a test from the Resend dashboard to an address you control and
   confirm `spf=pass`, `dkim=pass`, `dmarc=pass` in the message headers.

Resend rejects sends from an unverified domain (typically HTTP 403), and the app
surfaces that as a delivery failure in the account-email flow.

## 4. Vercel environment variables

Scope matters. **Preview** must be scoped to the `staging` branch, otherwise
every feature preview would claim the staging origin.

| Variable | Production (`main`) | Preview (`staging`) |
|---|---|---|
| `APP_URL` | `https://www.thanatos.mx` | `https://staging.thanatos.mx` |
| `MAIL_TRANSPORT` | `resend` | `resend` |
| `MAIL_FROM` | `Solara <no-reply@thanatos.mx>` | `Solara <no-reply@thanatos.mx>` |
| `MAIL_REPLY_TO` | `info@thanatos.mx` | `info@thanatos.mx` |
| `RESEND_API_KEY` | production key, **Sensitive** | staging key, **Sensitive** |
| `PROD_DB_ENDPOINT` | production endpoint label | comparison only (guard) |
| `STAGING_DB_ENDPOINT` | comparison only (guard) | staging endpoint label |

Other variables (`DATABASE_URL`, Stripe, maps, reading-generation settings) keep
their existing scopes; see [env-templates](env-templates.md).

Adding a value in the dashboard avoids leaving secrets in shell history. The CLI
works for Production, but its Preview selector applies to **all** Preview
branches, so branch scoping must be done in the dashboard:

```bash
vercel env add APP_URL production          # then type the value at the prompt
vercel env add MAIL_FROM production
vercel env add MAIL_REPLY_TO production
vercel env add RESEND_API_KEY production   # mark Sensitive in the dashboard
```

After saving, **redeploy** both environments. Existing deployments keep their
build-time values; server-side variables are read at runtime from the
deployment's environment snapshot, so a new deployment is the reliable path.

Format check (values are never printed):

```bash
# In a secure shell with the target values exported, or with the file copied to .env.staging
node scripts/check-setup.mjs staging --strict
node scripts/check-setup.mjs production --strict
```

## 5. Stripe

Stripe is not email, but the domain cutover touches two URLs:

- **Checkout return URLs** come from `APP_URL`, so they follow the new origin
  automatically after the redeploy.
- **Webhook endpoint** is configured in the Stripe Dashboard. Move it to
  `https://www.thanatos.mx/api/billing/webhook` (or
  `https://staging.thanatos.mx/api/billing/webhook` for test mode) and copy the
  **new** signing secret into `STRIPE_WEBHOOK_SECRET`. A new endpoint has its own
  secret; keeping the old one silently rejects every delivery.

The old `*.vercel.app` endpoint can stay enabled during the transition; delivery
to either one is signature-verified and idempotent.

## 6. Verification

```bash
set -a; . ./.env; set +a   # VERCEL_AUTOMATION_BYPASS_SECRET only

curl -fsS https://www.thanatos.mx/api/version
curl -fsS https://www.thanatos.mx/api/ready
curl -fsS -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  https://staging.thanatos.mx/api/version
curl -fsS -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  https://staging.thanatos.mx/api/ready
```

Expected: `env` is `production` / `staging` respectively, and `/api/ready` is
`{"ok":true,…,"migrations":"exact"}`. The apex must answer with a 308 to `www`
and must not serve the app.

Mail flow (receive it, do not just watch logs):

1. Production: sign up a fresh address → the claim email link host is
   `www.thanatos.mx`.
2. Staging: same, link host is `staging.thanatos.mx`.
3. Password reset on a verified account → link host and delivery are correct.
4. In the received message, check `SPF`, `DKIM` and `DMARC` pass, and that
   `Reply-To` is `info@thanatos.mx`.

Security headers should show HSTS on production only (staging is a Preview
deployment, so `staticSecurityHeaders` omits it there):

```bash
curl -sSI https://www.thanatos.mx | grep -i strict-transport-security
```

## 7. DMARC progression

1. Start with `p=none` and a reporting address (`info@thanatos.mx`) for at least a week.
2. Confirm legitimate mail (account claim, reset, Stripe receipts if the domain
   is used there) passes alignment.
3. Move to `p=quarantine`, observe, then `p=reject`.

Do not submit the domain to the HSTS preload list at the same time. The app
already emits `includeSubDomains; preload` on production responses, but
submission is a separate, hard-to-reverse commitment that requires every
subdomain — including any future mail or tooling host — to be HTTPS-only.

## 8. Rollback

- **Domain problem:** remove or repoint the custom domain in Vercel and set
  `APP_URL` back to the `*.vercel.app` origin; redeploy. The old host remains
  valid until DNS changes propagate.
- **Mail problem:** set `MAIL_TRANSPORT=postmark` with a verified Postmark sender,
  or switch the Resend key; then redeploy. Do not use `outbox` outside local
  development.
- **Webhook problem:** restore the previous Stripe endpoint and its signing
  secret. Do not disable the webhook while subscriptions are live.

## 9. Pitfalls

- **Host-only cookies.** Sign-in state does not follow a host change. Users on
  the old `*.vercel.app` origin must sign in again on the custom domain; that is
  expected, not a bug.
- **Apex serving the app.** Cookies, CSP `'self'`, and the mutation-origin check
  are per-origin. Redirect the apex; do not let it serve pages.
- **Preview leakage.** `APP_URL` and mail keys in unscoped Preview variables
  would give every branch the staging origin and a live sender. Scope them to
  `staging`.
- **Strict preview isolation.** Feature previews still need an isolated Neon
  endpoint (or quarantine). Pointing them at staging or production is rejected by
  `src/db/url-guard.ts`.
- **`MAIL_FROM` must be on the verified domain.** A gmail.com or other-domain
  sender will fail SPF/DKIM alignment and be rejected or spam-filed.
- **Do not prefix the API key with `NEXT_PUBLIC_`.** It would be embedded in the
  browser bundle.
- **`.vercel.app` stays reachable.** Vercel keeps the deployment URL alive; treat
  it as an internal fallback and do not advertise it.
