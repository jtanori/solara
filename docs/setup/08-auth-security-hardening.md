# 8. Auth and security hardening

Status: implemented on `feat/53-54-56-57-auth-security-hardening` for #53, #54, #56, #57. CSP is report-only until a clean observation window; see the rollout section.

## Environment

| Variable | Local | Staging / production |
|---|---|---|
| `MAIL_TRANSPORT` | unset → `outbox` | `resend` or `postmark` |
| `MAIL_FROM` | optional for outbox | required, valid sender |
| `MAIL_REPLY_TO` | optional | optional |
| `RESEND_API_KEY` | — | required when `MAIL_TRANSPORT=resend` |
| `POSTMARK_SERVER_TOKEN` | — | required when `MAIL_TRANSPORT=postmark` |
| `CSP_MODE` | `report-only` | `report-only`, then `enforce` |

Local outbox messages are written to `.mail-outbox/*.eml` with mode `0600`. They are gitignored and never logged. `MAIL_TRANSPORT=outbox` is rejected in production. `node scripts/check-setup.mjs staging --strict` validates format only; it does not verify provider delivery.

## Rate limiting (#53)

`src/lib/rate-limit.ts` stores hashed keys in the `rate_limits` table.

| Route | Budget |
|---|---|
| Sign-up | 5/hour per IP, 3/hour per email |
| Sign-in IP ceiling | 100 attempts/15 min per IP |
| Sign-in IP failures | 50 failures/15 min per IP |
| Sign-in account | 10 failures/15 min per email |
| Claim attempt | 10/hour per IP |
| Claim resend | 10/hour per IP, 3/15 min per email |
| CSP reports | 60/min per IP |

Sign-in attempts for one email are serialized with a PostgreSQL advisory lock. The account failure budget is checked before `scrypt`, so rotating IPs cannot bypass it. After 10 failures the account backs off progressively from 30 seconds to 15 minutes. A correct password after the backoff succeeds and resets the failure state. The accepted tradeoff is that an attacker can repeatedly cause short lockouts; CAPTCHA/Turnstile is the future mitigation.

Blocked requests return `429` with `Retry-After`; the response never reveals whether an email exists. Unknown accounts use the same dummy scrypt path and the same generic failure.

Inspect state without raw emails or IPs:

```bash
npm run rate-limits:report
npm run rate-limits:cleanup
```

The report shows triggered rows first (`NULLS LAST`). Password hashing is async `scrypt` (`src/lib/passwords.ts`).

## Account claim and email transport (#54)

`src/lib/mail.ts` exposes `sendMail({ to, subject, text, html? })` and selects a provider from the environment. Hosted environments must configure a provider; a missing provider is a hard failure. Delivery runs in `after()`, after the HTTP response, so provider latency does not reveal whether a signup created an account.

Email domain setup (owner-only):

1. Verify the sending domain with Resend or Postmark.
2. Publish the provider's SPF and DKIM records.
3. Set `MAIL_FROM` to the verified sender and add `MAIL_REPLY_TO` if replies should go elsewhere.
4. Send a staging sign-up and confirm delivery in a real browser before promotion.
5. Do not log message bodies or tokens. Provider click tracking should be disabled where possible.

Claim flow:

1. Sign-up collects name and email only. It creates an unverified user with an unusable pending password hash and returns the same generic `200` for new, unverified-existing, and verified-existing addresses. No session is created.
2. A claim token is stored SHA-256-hashed with purpose `account_claim` and a 24-hour expiry. The email link is `/verify-email?lang=…#token=…`; the token is in the fragment, not the request URL.
3. The page reads the fragment, clears it after capture, and asks the mailbox owner to choose a password.
4. `POST /api/auth/claim` consumes the token, sets the chosen password and `email_verified_at`, deletes all sessions for the user, and invalidates sibling tokens atomically.
5. Legacy unverified accounts are not backfilled. They must claim and set a new password; sessions for unverified users are revoked by migration `0002`.
6. `POST /api/auth/verify/request` resends a claim link with a 60-second cooldown. `GET /api/auth/verify` is a non-mutating transition page for old query-style links; it never consumes a token.

Delivery states:

- **Provider success:** finalize the new token and delete older unused tokens.
- **Definitive rejection:** discard the new token; a previously delivered link stays valid.
- **Timeout/ambiguous acceptance:** keep both tokens active; do not auto-retry.
- **Crash after response:** the user can resend; old tokens remain valid.

`consume`-equivalent claim logic invalidates all sibling unused tokens when one succeeds. No plaintext token is stored in the database, logs, or a durable queue.

Policy: unverified users cannot sign in. `POST /api/billing/checkout` and `DELETE /api/profile` still return `403` with `code: "email_not_verified"`; the stronger rule is that no session is issued before the claim. The dashboard shows a verification notice when needed. Password recovery for already-verified accounts remains #55.

Tokens are never written to application logs. Claim responses use `Cache-Control: no-store`; the claim page clears the fragment after capture.

## Migration order

Migration `0002_email_verification` is additive and removes unverified sessions. Apply and verify migrations with the approved runner **before** merging/deploying:

```bash
npx tsx scripts/db-run.ts --env staging status
npx tsx scripts/db-run.ts --env staging migrate
npx tsx scripts/db-run.ts --env staging verify
```

`verify` checks `rate_limits`, `email_tokens`, `users.email_verified_at`, and the new indexes. Do not edit `0002` in place if it has run in a persistent environment; use an audited forward repair. The production promotion waits for the separate exact-SHA migration-gate PR.

## Strict origin checks (#56)

`src/proxy.ts` runs before mutating API routes. For `POST`, `PUT`, `PATCH`, and `DELETE` under `/api/*`:

- Compare the complete `Origin` (scheme, host, port) against `APP_URL`, configured Vercel origins, and the actual request target origin.
- Accept when `Origin` is absent and `Sec-Fetch-Site: same-origin`.
- Reject with `403` when both are absent, the scheme differs, the port differs, or the origin is foreign.
- Pass `GET`, `HEAD`, and `OPTIONS`.

The proxy matcher has a dedicated `/api/:path*` entry plus the asset-filtered page entry, so an API path ending in `.png`, `.js`, or another asset extension cannot skip the guard.

Exemptions:

- `/api/billing/webhook` — authenticated by the Stripe signature.
- `/api/csp-report` — browser-generated reports; content type and size are validated.

There is no Bearer exemption. No validated bearer flow exists yet; add one only with a real cookie-independent authentication check.

New mutating routes inherit the proxy automatically; do not add per-route copies of the check.

## Security headers and CSP (#57)

`next.config.ts` and `src/lib/security-headers.ts` set:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` — production only.
- `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`.
- `Referrer-Policy: strict-origin-when-cross-origin`; `no-referrer` for `/reading/*` and `/api/readings/*`.
- `X-Content-Type-Options: nosniff`.
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
- `Cache-Control: private, no-store` for authenticated pages and API routes.
- Nonce-based CSP for document requests.

CSP allowlist:

| Directive | Sources |
|---|---|
| `script-src` | self, per-request nonce, `strict-dynamic`; `unsafe-eval` only in development |
| `style-src` | self, Google Fonts; inline style attributes allowed for React/Leaflet |
| `font-src` | self, `fonts.gstatic.com` |
| `img-src` | self, `blob:`, `data:`, OpenStreetMap tiles, configured `NEXT_PUBLIC_MAP_TILE_URL` origin |
| `connect-src` | self; `ws:`/`wss:` in development |
| `object-src` | `none` |
| `base-uri` / `form-action` | `self` |
| `frame-ancestors` | `none` |
| `report-uri` | `/api/csp-report` |

To add a third-party origin, extend `buildCsp()` in `src/lib/security-headers.ts`, update the table above, and confirm the report stream stays clean.

CSP rollout:

1. Deploy with `CSP_MODE=report-only`.
2. Exercise home, sign-in, dashboard, create/map, reading/PDF, admin, and Stripe checkout in staging.
3. Watch `/api/csp-report` logs for violations for one clean week.
4. Set `CSP_MODE=enforce` in staging, repeat QA, then set it in production.
5. Do not claim #57 complete until enforcement is verified.

## Verification

```bash
npx drizzle-kit migrate                 # loopback disposable DB only
npx next typegen
npm exec tsc -- --noEmit --pretty false
npx eslint src tests scripts --max-warnings=0
RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts
npm run build
node scripts/check-setup.mjs local
npx tsx scripts/db-run.ts --env local verify
```

Staging acceptance:

- A fresh sign-up returns the same generic response as an existing address and creates no session.
- The delivered claim link opens a confirmation page; the mailbox owner chooses a password and can then sign in.
- A scanner-like GET leaves the account unverified; reuse/expiry fails with a resend option.
- Ten distributed failures block the account until the backoff expires; a correct password then succeeds.
- Twelve successful logins across accounts from one shared IP all return `200`.
- A mutating API request with no `Origin`/`Sec-Fetch-Site` returns `403`; mixed-scheme origins, fake Bearer headers, and `.png` API paths are rejected.
- HTML responses carry the security headers; no CSP violations appear in the report stream.
- Maps, Stripe test checkout, PDF download, and sign-in still work.
