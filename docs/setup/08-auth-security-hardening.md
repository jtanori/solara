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

| Route | Per IP | Per email |
|---|---|---|
| Sign-up | 5 / hour | 3 / hour |
| Sign-in | 10 / 15 min | 10 failed / 15 min |
| Verification resend | 10 / hour | 3 / 15 min |
| Verification link | 10 / hour | — |
| CSP reports | 60 / min | — |

Failed sign-ins also increment an IP+email failure key. After 5 failures the key backs off exponentially from 30 seconds up to 15 minutes. A successful sign-in clears the failure state. Blocked requests return `429` with `Retry-After`; the response never reveals whether an email exists.

Inspect state without raw emails or IPs:

```bash
npm run rate-limits:report
```

The script prints key prefixes, counts, failures, block expiry, and last trigger. Expired rows can be deleted by an operator or a scheduled job:

```bash
npm run rate-limits:cleanup
```

The table has an index on `expires_at`.

Password hashing is async `scrypt` (`src/lib/passwords.ts`). Rate limiting bounds work before hashing; if a deployment needs more concurrency, tune the Node/libuv threadpool rather than reintroducing synchronous hashing.

## Email transport and verification (#54)

`src/lib/mail.ts` exposes `sendMail({ to, subject, text, html? })` and selects a provider from the environment. Hosted environments must configure a provider; a missing provider is a hard failure.

Email domain setup (owner-only):

1. Verify the sending domain with Resend or Postmark.
2. Publish the provider's SPF and DKIM records.
3. Set `MAIL_FROM` to the verified sender and add `MAIL_REPLY_TO` if replies should go elsewhere.
4. Send a staging sign-up and confirm delivery before promotion.
5. Do not log message bodies or tokens; provider dashboards may retain metadata.

Verification flow:

1. Sign-up creates the user and a `email_tokens` row with a SHA-256 hash, purpose `email_verification`, and a 24-hour expiry.
2. The email links to `/api/auth/verify?token=…&lang=…`.
3. The route consumes the token once and redirects to `/verify-email?status=verified|used|expired|invalid|rate_limited|error`.
4. The page offers a resend form. `POST /api/auth/verify/request` is idempotent and returns a generic success response; a 60-second cooldown prevents token churn.
5. Existing accounts were backfilled as verified in migration `0002_email_verification`.

Policy: sign-in stays available. `POST /api/billing/checkout` and `DELETE /api/profile` return `403` with `code: "email_not_verified"` until the address is verified. The dashboard shows a verification notice when needed.

Tokens are never written to application logs. The verification route sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; platform access logs may still record the request URL, so do not paste verification links into tickets or chat.

## Strict origin checks (#56)

`src/proxy.ts` runs before mutating API routes. For `POST`, `PUT`, `PATCH`, and `DELETE` under `/api/*`:

- Accept when `Origin` matches the host in `APP_URL` or the request `Host` (covers custom domains and `*.vercel.app` previews).
- Accept when `Origin` is absent and `Sec-Fetch-Site: same-origin`.
- Reject with `403` when both are absent or the origin is foreign.
- Pass `GET`, `HEAD`, and `OPTIONS`.

Exemptions:

- `/api/billing/webhook` — authenticated by the Stripe signature.
- `/api/csp-report` — browser-generated reports; content type and size are validated.
- `Authorization: Bearer …` — no cookie, so no CSRF surface; future mobile/API clients use this path.

`GET` endpoints are not origin-gated. New mutating routes inherit the proxy automatically; do not add per-route copies of the check.

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
```

Staging acceptance:

- 11 rapid failed sign-ins for one email return `429` with `Retry-After`.
- A fresh sign-up delivers a verification email; the link verifies once, and reuse or expiry fails with a resend option.
- An unverified account can browse but receives `403` for checkout and account deletion.
- A mutating API request with no `Origin`/`Sec-Fetch-Site` returns `403`; the real app still signs up, saves charts, and deletes accounts.
- HTML responses carry the security headers; no CSP violations appear in the report stream.
- Maps, Stripe test checkout, PDF download, and sign-in still work.
