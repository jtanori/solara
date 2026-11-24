# 2. Stripe subscriptions and pricing

## What is implemented

The server creates Stripe Checkout sessions in `subscription` mode, verifies signed raw-body webhooks, deduplicates event IDs and retrieves the latest subscription state. Only an active/trialing, unexpired subscription for the Premium product and an allowed price grants access. The customer portal manages billing. MXN is the default; USD appears only when an active USD price is configured. The app does not invent an amount. The current checkout does not enable automatic tax calculation; agree on and implement tax handling before charging customers.

## Variables (server-side only)

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Secret or restricted Stripe key for the correct mode. Never prefix with `NEXT_PUBLIC_`. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this particular CLI listener or Dashboard destination. |
| `STRIPE_PRICE_ID_MXN` | Active recurring MXN Price ID; required to enable Checkout. |
| `STRIPE_PRICE_ID_USD` | Optional active recurring USD Price ID. |
| `STRIPE_PREMIUM_PRICE_IDS` | Optional comma-separated older Premium Price IDs to preserve existing subscribers during price changes. |
| `APP_URL` | Canonical app origin used for Checkout and portal return URLs. |

The pricing page reads the amount, currency and billing interval from Stripe. Create recurring prices with the billing period and amount approved for each market; no amount is preselected in the code.

## Hosted origins and environment scopes

| Environment | Canonical `APP_URL` | Stripe mode | Webhook destination |
|---|---|---|---|
| Staging | `https://staging.thanatos.mx` | test | `https://staging.thanatos.mx/api/billing/webhook` |
| Production | `https://www.thanatos.mx` | live | `https://www.thanatos.mx/api/billing/webhook` |

Scope staging values to Vercel **Preview → Git branch `staging`**; production values to **Production**. Each environment has its own key, prices and signing secret. A price ID from one mode does not resolve in the other.

`billingIsConfigured()` is `STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET && STRIPE_PRICE_ID_MXN`. Checkout returns `503 "Payments are not configured yet."` until all three exist — **the webhook secret is required before a single session can be created**, even though delivery is a later step.

`APP_URL` builds Checkout's `success_url` (`/dashboard?billing=success`), `cancel_url` (`/pricing?billing=cancelled`) and the portal return URL. Session cookies are host-only, so `APP_URL` must already be the custom origin before billing QA; otherwise the payer is redirected to a different host and appears signed out.

Do not set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`. Checkout is created server-side and redirects to Stripe; no browser-side Stripe SDK is loaded, and nothing reads that variable.

## Local setup

1. In a Stripe **test** account/sandbox, create a Premium product and an active recurring MXN price. Optionally add an active recurring USD price. Use test-mode price IDs and a test secret key in your local environment.
2. Configure the Stripe customer portal in test mode, limiting available plans to the intended Premium product. Enable the cancellation/payment-method behavior you intend to support.
3. Install and authenticate the [Stripe CLI](https://docs.stripe.com/stripe-cli). In a separate terminal run `stripe listen --forward-to localhost:3000/api/billing/webhook`. Put the listener's signing secret in local `STRIPE_WEBHOOK_SECRET`; it is different from a Dashboard endpoint secret. Set `APP_URL=http://localhost:3000`, restart the app, and run `node scripts/check-setup.mjs local --strict` once the remaining settings are ready.
4. Sign up in the app, open `/pricing`, select MXN, and complete a **test-mode** checkout using an [official Stripe test card](https://docs.stripe.com/testing). Wait for the webhook: the return redirect alone never grants Premium. Verify the account plan and the three-page Premium PDF, then manage or cancel the subscription in the portal.
5. Test a declined payment, repeated event, cancellation, failed renewal and a return before the webhook is delivered. A generic `stripe trigger checkout.session.completed` may not contain this app's user metadata; a checkout initiated from the app is the meaningful end-to-end test.

## Staging setup

1. Use **test-mode** resources separate from production: a Premium product, an active recurring MXN price (and optional USD), the test secret key, `APP_URL=https://staging.thanatos.mx`, and the staging database. A separate test sandbox is preferable for isolation.
2. Register the endpoint at `https://staging.thanatos.mx/api/billing/webhook` and subscribe to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded`, and `invoice.payment_failed`. Copy **that endpoint's** signing secret into `STRIPE_WEBHOOK_SECRET`; it is not the CLI listener secret.
3. **Vercel Deployment Protection blocks the webhook.** The staging host requires authentication, so Stripe's POST is rejected before the app sees it. A `302` to `vercel.com/sso-api` in Workbench means protection, not a signature problem. Choose one:
   - append the project's automation bypass to the endpoint URL (`?x-vercel-protection-bypass=<secret>`) and confirm with **Send test event** that the response is `200`. Stripe stores that URL, so rotate the bypass secret after QA;

     The secret is **Vercel's**, not Stripe's: Vercel issues it (Project → Settings → Deployment
     Protection → *Protection Bypass for Automation*) and this step pastes a copy into Stripe's
     endpoint config because Stripe's URL field has no header option. The same value is also held by
     GitHub Environments `staging`, `production` and `monitoring`, and by your local `.env`;
     `11-actions-deploys.md` §2.1 lists every copy and the rotation checklist, and
     `bypass-secret-howto.md` walks through creating and verifying it. Stripe needs no Vercel
     environment variable, and no application code reads this value.
   - temporarily disable Vercel Authentication for Preview during test-mode QA, then re-enable it;
   - keep the hosted endpoint as a delivery smoke test only, and exercise signature, replay and ordering locally with `stripe listen --forward-to localhost:3000/api/billing/webhook`.

   Production has no such constraint: `www.thanatos.mx` is public.
4. Configure the test-mode customer portal: cancellation, payment-method update, invoices, and plan changes limited to the Premium product. The portal is configured per mode and opens only for a user who already has a `stripeCustomerId`, which exists after a first checkout.
5. Redeploy after any environment change; an existing deployment keeps its env snapshot.
6. With a verified synthetic account, confirm: `/pricing` shows the Stripe amount and interval (USD only if configured); a test-card checkout grants Premium **only after** the webhook; a declined payment grants nothing; replaying an event does not double-grant; cancellation ends access at period end; and account deletion is refused while a subscription is live.

## Production setup

1. Complete the launch gate, including verified auth, security, legal terms, tax/refund/cancellation policy and support procedures. Activate live Stripe only after approval. **Checkout does not enable automatic tax calculation**; agree and implement tax handling before charging anyone.
2. Create the live Premium product and live recurring MXN price; create USD only if offered. Set the live-only secret key, live price IDs, `APP_URL=https://www.thanatos.mx`, and a **different** production signing secret. Do not reuse local or staging keys.
3. Register the public production endpoint at `https://www.thanatos.mx/api/billing/webhook` with the same seven events and a new signing secret; no protection bypass is needed. Configure the live portal and limit plan changes to Premium.
4. Monitor signature failures, 5xx responses and Stripe retries. Test a carefully authorized live transaction/refund only under the organization's billing policy. Reconcile Stripe and database subscription state and keep a support process for failures.

## Price changes and troubleshooting

- Keep old active Premium Price IDs in `STRIPE_PREMIUM_PRICE_IDS` before replacing current prices; the webhook checks that allowlist. Existing database entitlements are recalculated on a **new** subscription event; changing an environment variable does not itself resync every subscription. Resending an already-processed event is deduplicated. Plan and test a controlled reconciliation process before changing prices.
- Checkout unavailable (`503` "Payments are not configured yet."): a secret, **webhook secret** or MXN price ID is missing. Checkout cannot be created before a webhook destination exists.
- Pricing page shows no amount: the price is inactive, one-time, in another currency, or from the other mode; `getPriceCatalog()` returns an empty list rather than guessing.
- Checkout completes but the payer returns signed out: `APP_URL` is not the host the checkout started on.
- Checkout completed but plan is free: inspect webhook delivery/signature, protection blocking, event metadata, matching Stripe customer, allowed price and subscription status. The handler returns 5xx for retryable failures and 2xx for unmapped/invalid events, so a green delivery is not proof of entitlement.
- Webhook `400`: signing secret belongs to a different endpoint or to a CLI listener.
- Portal `400`: the account has no `stripeCustomerId` yet.
- Deleting an account with an active/pending subscription is blocked; cancel through the portal and wait until it ends. Stripe may retain billing records according to its policies and legal obligations.

Sources: [Stripe subscription Checkout](https://docs.stripe.com/billing/subscriptions/build-subscriptions), [webhook signature verification](https://docs.stripe.com/webhooks/signature), [customer portal](https://docs.stripe.com/customer-management).
