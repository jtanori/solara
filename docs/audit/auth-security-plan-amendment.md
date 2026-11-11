# Auth and security — findings and amended plan

Companion to `auth-security-current-implementation.md` (verbatim source).
Every claim below was checked against the code; file:line references point at the dump.

**Status of verification.** I read every module and ran the suite that does not need a
database. There is no Postgres in this sandbox and no `.env`, so `npm test` reports
**254 pass / 11 fail**, and **all 11 failures are `DATABASE_URL is required`** plus one
pre-existing doc lint (fixed, see §7). I have *not* exercised the live paths: signup
against a real mail transport, webhook replay against Stripe, or readiness against a
migrated database. Nothing below is reported as passing that I did not run.

---

## 1. The security model, as it actually is

Worth stating plainly, because it is genuinely good and the plan should build on it
rather than beside it.

**Session.** Opaque 32-byte token in an `httpOnly`, `sameSite=lax`, `secure`-in-production
cookie. Only `sha256(token)` is stored (`sessions.tokenHash`). No JWT, so no signing-key
rotation problem and no way to forge claims client-side. Expiry is absolute (30 days) with
no sliding refresh.

**Login.** Three independent controls, all inside one transaction:
1. A per-IP fixed-window limit (`loginIp`: 100 / 15 min).
2. A per-IP *failure* counter with its own threshold (`loginIpFailures`: 50 / 15 min).
3. A per-account backoff that doubles from 30 s and caps at 15 min, triggered at 10 failures.

All three run inside `withLoginLocks(ip, email, …)`, which takes
`pg_advisory_xact_lock` on the IP and then the email **before** reading the counters — so
parallel attempts cannot all read count=0 and slip through. That is the part most
implementations get wrong, and it is right here.

**User enumeration.** Handled consistently: signup with an existing address returns
`{ok:true}` and emails the owner instead; login failure is one message for
"no such user" and "wrong password"; the password hash is compared against a dummy
(`passwordHashForLogin`) when the user is missing, so timing does not reveal existence;
verify-request and reset-request both return `{ok:true}` for unknown addresses.

**Hashing.** scrypt with explicit parameters, 32-hex salt, 128-hex hash, both validated
before use, `timingSafeEqual` on equal-length buffers. A `Semaphore(4, 256)` bounds
concurrent hashing so a burst of logins cannot exhaust CPU; overflow throws
`ScryptBusyError` → 503 rather than a timeout.

**CSRF.** `src/proxy.ts` (Next 16's renamed middleware) rejects any mutating request to
`/api/*` whose `Origin` is not the app origin, the request origin, or a known Vercel
deployment host. `/api/billing/webhook` and `/api/csp-report` are explicitly exempt — the
webhook is signature-verified instead. Missing `Origin` is allowed **only** when
`Sec-Fetch-Site: same-origin`, which modern browsers set and cross-site forms cannot forge.

**Tokens.** 32 random bytes, sha256 at rest, 24 h TTL (reset: 1 h), 60 s cooldown per
purpose, single-use enforced by `usedAt` inside a `for update` row lock, and issuing a new
token invalidates the previous unused ones. Password reset revokes every session for the
user; claiming an account does too.

**Headers.** Nonce-based `script-src 'strict-dynamic'`, `object-src 'none'`,
`frame-ancestors 'none'`, `base-uri 'self'`. CSP is **report-only unless `CSP_MODE=enforce`**.
Authenticated routes get `private, no-store` from `next.config.ts:headers()`.

**Billing.** Signature verified with the raw body; every event id is inserted into
`stripe_events` with `onConflictDoNothing` so replays no-op; per-subscription advisory lock
then a *fetch of current state from Stripe* rather than trusting the event payload, which
is the correct answer to out-of-order delivery. `grantsAccess` requires both
`metadata.solara_product === "premium"` **and** `isPremiumPrice(priceId)`.

**Where it is thin.** Everything below is a real gap I verified, not a style note.

---

## 2. Findings

Severity is my judgement of exploitability × impact in the current deployment.

### S1 — Account deletion is the only destructive admin-class action with no audit row

`src/app/api/profile/route.ts:DELETE` deletes a user (cascading sessions, readings,
documents, subscriptions) and writes nothing to `audit_logs`. Role changes
(`admin/users`) and editorial edits (`admin/knowledge`) are both audited, as is
`password:reset`. The single most destructive thing a user can do — and the thing
support will be asked about — leaves no trace beyond the absence of a row.

It is also not idempotent against the "delete twice" case in a useful way, and it does not
record *when* billing was verified (a `409` path that touched Stripe).

**Fix:** one `auditLogs` insert inside a transaction with the delete:
`action: "account:delete", target: user.id, actorId: user.id`. Cheap, and it makes the
deletion provable.

### S2 — `/api/readings` and the PDF route have no rate limit

`POST /api/readings` runs `calculateSolarReturn` + (when enabled) LLM generation. The PDF
route runs `@react-pdf/renderer`. Neither calls `consumeRateLimit`; every other
expensive endpoint does (`placesIp`, `cspReportIp`, auth paths). A signed-in account can
loop either route. Today that costs CPU; the moment step 6 of the readings plan lands it
costs **money per call** against the 10 MXN paid ceiling, with no per-user cap at all.

**Fix:** `readingsCreateIp` / `readingsCreateUser` policies, consumed before the work.
The pipeline's ceiling is per document, not per day — those are different controls and
only one of them exists.

### S3 — `clientIp` trusts `X-Forwarded-For` from any caller

`rate-limit.ts:clientIp` takes the leftmost `X-Forwarded-For` entry. Behind a proxy that
*appends*, leftmost is the client (correct). A direct client that sets the header itself
chooses its own key — every request appears to come from a new IP, so per-IP limits never
trip. On Vercel the header is set by the platform and this is safe; the code does not
encode that assumption anywhere, and `tests/rate-limit.test.ts:18` asserts the leftmost
semantics as a *feature*.

This is defensible as-is, but the assumption must be written down, and any future
self-hosted deployment silently loses its per-IP limits. Per-account and per-email limits
(which are keyed on the submitted address, not the IP) still hold, which is why this is
S3 and not S1.

**Fix:** a comment plus a documented contract ("the edge proxy must set or overwrite
XFF"); optionally prefer `x-real-ip`/`cf-connecting-ip` when present (the code already
falls back to them when XFF is absent).

### S4 — `/api/ready` is public and enumerates your schema

The route requires no authentication and returns, on a misconfigured database, the exact
list of missing tables, missing columns, missing indexes, pending and unexpected migration
counts, and whether auth is degraded. That is a useful attacker map of what is wrong and
what to aim at during an incident.

**Fix:** keep it public for uptime checks but gate the *details* — return `{ ok: false }`
to unauthenticated callers and the full object only with a bearer token (or to
`NODE_ENV=development`). Note `next.config.ts` does not add `no-store` to `/api/ready`
(it sets it in the handler, which is fine, but the route is not in the `headers()` list).

### S5 — Account deletion has no session-scoped re-authentication

`DELETE /api/profile` acts on the cookie alone. A borrowed unlocked browser — or any XSS
that survives the CSP — deletes an account and everything in it with one request. The
`emailVerifiedAt` check protects *unverified* accounts, not *the current holder of a
session*.

**Fix:** require the current password (or a fresh email confirmation) in the body. This is
the one place where "you are already signed in" is not enough.

### S6 — Sessions never rotate on privilege change

`hasPremiumAccess` is derived per request (good), but a session established before a role
or entitlement change stays valid with no rotation. There is no "sign out everywhere",
and no way for an admin to force a session to end: the admin panel manages roles, not
sessions. `createSessionInTransaction` inserts with a fixed 30-day expiry and nothing
refreshes or rotates it.

Impact is limited (role and plan are read fresh from the DB, so a demoted admin loses
access immediately), but a *stolen* session cannot be revoked without deleting the user.

**Fix (small):** store `sessions.createdAt`, expose "sign out all devices", and delete
`users.id`'s sessions from the account page. `claimAccountWithToken` and
`resetPasswordWithToken` already do exactly this on their paths — the primitive exists.

### S7 — Checkout and portal have no rate limit; portal session creation is unbounded

`POST /api/billing/checkout` and `/api/billing/portal` call Stripe on every request with
no limit. Checkout already avoids duplicate subscriptions (409) and reuses open sessions,
so the damage is Stripe API quota and cost, not duplicate billing. `portal` creates a new
session per call — a signed-in user can loop it.

**Fix:** one policy each (`billingIp`, 10/min is generous).

### S8 — `scrypt` parameters are implicit

`scryptPool.run` calls the runner with keylen 64 and no explicit `N`/`r`/`p`, so the
parameters are the Node defaults (N=16384, r=8, p=1) and are *not stored with the hash*.
The stored format is `salt:hash` only. Raising the cost later cannot distinguish old from
new hashes, so a migration would have to guess or rehash on next successful login.

**Fix:** store `scrypt$16384$8$1$salt$hash` going forward, accept the legacy
`salt:hash` form on verify, and rehash on successful login. This is the standard shape and
it is a small, contained change to `passwords.ts`.

### S9 — CSRF relies entirely on `Origin`/`Sec-Fetch-Site`

There is no per-session CSRF token. That is acceptable for a same-site cookie app behind a
modern browser, and the `Sec-Fetch-Site` fallback is a reasonable belt. It breaks down if
(a) an old browser omits both headers and omits `Origin` — then the request is rejected,
which is fail-closed and fine — or (b) a future integration needs cross-origin POSTs, at
which point the exempt list becomes the attack surface. Not urgent; worth a documented
decision rather than a code change.

### S10 — Misc, verified, low impact

- `recordAuthFailure`, `clearAuthFailures`, `getRateLimitState` (non-`Tx` variants) have
  **zero callers**. Dead but tested; either wire them or drop them.
- `rate_limits` cleanup is a manual npm script (`rate-limits:cleanup`); there is no
  `vercel.json` and no cron entry, so nothing runs it. The table grows unbounded in
  production until someone remembers.
- `log.ts` redacts `email` and any key matching `/birth/`, so birth data never reaches
  logs. Good — but note it also redacts `stripeCustomerId` via `/stripe/`, so billing
  debugging from logs will show `[redacted]`.
- `/api/health` returns `{ok:true}` unconditionally — a liveness probe that cannot fail.
  Fine as a liveness probe, misleading as a health probe; `/api/ready` is the real one.

---

## 3. What a plan for this area usually gets wrong

Applying the same test I applied to the readings plan: the work here is mostly **not**
"add security", it is "finish and document what exists". Concretely, do not build:

- another session mechanism (cookies + sha256 is correct and complete),
- another rate limiter (the Postgres one is transactional and correctly ordered),
- another CSRF scheme (origin checking is in place and exempted deliberately),
- a second password hashing path (scrypt + semaphore is right; only the *format* needs
  fixing),
- an `isAdmin` helper (use `canManageUsers` / `canEditKnowledge`, which already encode
  the role matrix).

And do not "harden" CSP to enforce before reading the CSP report stream — the report
endpoint is built for exactly that, and it is already rate-limited and body-capped.

---

## 4. Amended sequence

Ordered by risk retired per unit of change. Each step is testable without a browser.

### Step A — Audit the destructive paths (S1, S5) — hours

- `DELETE /api/profile` writes `auditLogs{action:"account:delete"}`, and the existing
  `409`/`503` billing branches record that billing was checked and why deletion was
  refused.
- Require the current password. `verifyPassword` exists; the route already has the user.
  Return the same error shape as the other 400s so the client form can show it.

Tests: unit-level against a fake db (the pattern `auth-endpoint.test.ts` uses) — no
password ⇒ 400 and no delete; wrong password ⇒ 400 and no delete; correct ⇒ delete + audit
row; ongoing subscription ⇒ 409 and *no* audit row (nothing was deleted).

### Step B — Rate-limit the metered surfaces (S2, S7)

Add policies to `AUTH_RATE_LIMITS`, consume them at the top of `/api/readings`,
`/api/readings/[id]/pdf`, `/api/billing/checkout`, `/api/billing/portal`. Reuse
`consumeRateLimit` — do not invent a second limiter. Key on `user.id` for authenticated
routes and IP only as a secondary budget.

**This must land before the readings paid-generation step**, because that is the first
endpoint whose abuse costs real money.

### Step C — Readiness and diagnostics exposure (S4)

Split the ready payload: `{ ok }` public, full detail behind a token or dev-only. Add
`/api/ready` to the `no-store` list in `next.config.ts` for consistency.

### Step D — Password hash format (S8)

`salt:hash` → `scrypt$N$r$p$salt$hash`, verify both, rehash on login. One migration-free
change; no user action.

### Step E — Session lifecycle (S6)

`createdAt` + "sign out everywhere" + admin-visible session revocation. This is a feature,
not a fix, and it is the largest item here.

### Step F — Document the trust assumptions (S3, S9)

Write down, in `docs/decisions.md`: XFF is set by the edge; origin checking is the CSRF
control and there is no token; CSP stays report-only until the report stream is clean.
Decisions that live only in my head are the failure mode this whole exercise is about.

### Step G — Housekeeping (S10)

Either wire the dead rate-limit helpers or delete them; schedule `rate-limits:cleanup`
(a cron or a Vercel scheduled function — note there is no `vercel.json` today, so this is
a new decision, not a config edit).

---

## 5. What I could not run, and what that means

`DATABASE_URL` is unset and there is no Postgres binary in this sandbox, so:

- `auth-endpoint`, `email-verification`, `password-reset`, `rate-limit`,
  `rate-limit-report`, `readings-db`, `subscription-access`, `billing-integration`,
  `db-pool`, `places` — **not run** (11 failures, all `DATABASE_URL is required`).
- `passwords`, `request-security`, `security-headers`, `ready-route`,
  `schema-verification`, `usage-guide-access`, `billing` (unit) — **run and passing**
  as part of the 254.

I did not start a database to change that: `db:seed:local` and the integration tests are
written for a disposable local database, and inventing one here would not prove anything
about the deployed one. Every claim above about database behaviour comes from reading the
SQL and the locks, not from executing them — with the exception of anything I explicitly
call "verified by grep".

---

## 6. One-paragraph version

The auth and security layer is in better shape than the readings layer: cryptographically
sound sessions, correctly ordered transactional rate limiting, real advisory locks,
non-enumerable error paths, verified webhooks, and a readiness probe that fails closed.
The gaps are at the edges — a destructive action with no audit trail, two metered
endpoints with no limit, a public schema-disclosure endpoint, a password format that
cannot be upgraded in place, and no way to revoke a session. Fix those in that order and
write down the two trust assumptions; do not rebuild anything that already works.

---

## 7. Fixed in this branch

`docs/audit/open-issues-by-milestone-2026-11-11.md` contained two table rows that named the
retired legacy backlog file, which made `tests/backlog-snapshot.test.ts` fail (it forbids
any active document from naming that retired file). The rows now say "retire the committed
legacy backlog file" — the issue title is preserved in meaning without re-introducing the
filename. This was a pre-existing failure at `dd8d707`, not something introduced by this
work.
