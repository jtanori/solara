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

## Local setup

1. In a Stripe **test** account/sandbox, create a Premium product and an active recurring MXN price. Optionally add an active recurring USD price. Use test-mode price IDs and a test secret key in your local environment.
2. Configure the Stripe customer portal in test mode, limiting available plans to the intended Premium product. Enable the cancellation/payment-method behavior you intend to support.
3. Install and authenticate the [Stripe CLI](https://docs.stripe.com/stripe-cli). In a separate terminal run `stripe listen --forward-to localhost:3000/api/billing/webhook`. Put the listener's signing secret in local `STRIPE_WEBHOOK_SECRET`; it is different from a Dashboard endpoint secret. Set `APP_URL=http://localhost:3000`, restart the app, and run `node scripts/check-setup.mjs local --strict` once the remaining settings are ready.
4. Sign up in the app, open `/pricing`, select MXN, and complete a **test-mode** checkout using an [official Stripe test card](https://docs.stripe.com/testing). Wait for the webhook: the return redirect alone never grants Premium. Verify the account plan and the three-page Premium PDF, then manage or cancel the subscription in the portal.
5. Test a declined payment, repeated event, cancellation, failed renewal and a return before the webhook is delivered. A generic `stripe trigger checkout.session.completed` may not contain this app's user metadata; a checkout initiated from the app is the meaningful end-to-end test.

## Staging setup

1. Use separate **test-mode** Stripe resources and staging database. Set the test key, staging MXN/optional USD Price IDs and `APP_URL` to the staging HTTPS origin. A staging sandbox or separately managed test account is preferable for isolation.
2. Register a staging HTTPS webhook destination at `https://<staging-domain>/api/billing/webhook` and use its own signing secret. Subscribe to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_succeeded`, and `invoice.payment_failed`.
3. Configure the staging test-mode customer portal. Ensure Vercel deployment protection or a firewall does not block the webhook. Redeploy after environment changes and verify delivery in Stripe Workbench; a `2xx` alone is not proof of entitlement—also check the app account.
4. Exercise test-mode success, decline, renewal, cancellation, replay and delayed/out-of-order events with synthetic accounts. Confirm the app does not allow duplicate subscriptions and that the correct MXN or USD amount and interval appear before confirmation.

## Production setup

1. Complete the launch gate, including verified auth, security, legal terms, tax/refund/cancellation policy and support procedures. Activate live Stripe only after approval.
2. Create the live Premium product and live recurring MXN price; create USD only if offered. Set live-only secret key, live price IDs, production `APP_URL`, and a **different** production webhook signing secret in the production secret manager. Do not reuse local or staging keys.
3. Register the production HTTPS webhook destination and the same event types; configure the live portal. Limit portal plan changes to the intended Premium product. Validate the real price, billing interval, receipt, cancellation and tax settings before customers are charged.
4. Monitor signature failures, 5xx responses and Stripe retries. Test a carefully authorized live transaction/refund only under the organization's billing policy. Reconcile Stripe and database subscription state and have a support process for failures.

## Price changes and troubleshooting

- Keep old active Premium Price IDs in `STRIPE_PREMIUM_PRICE_IDS` before replacing current prices; the webhook checks that allowlist. Existing database entitlements are recalculated on a **new** subscription event; changing an environment variable does not itself resync every subscription. Resending an already-processed event is deduplicated. Plan and test a controlled reconciliation process before changing prices.
- Checkout unavailable: check all required values, matching test/live modes, active recurring MXN price and app logs. Do not print secrets.
- Checkout completed but plan is free: inspect webhook delivery/signature, event metadata, matching Stripe customer, allowed price and subscription status. The handler returns 5xx for retryable failures.
- Deleting an account with an active/pending subscription is blocked; cancel through the portal and wait until it ends. Stripe may retain billing records according to its policies and legal obligations.

Sources: [Stripe subscription Checkout](https://docs.stripe.com/billing/subscriptions/build-subscriptions), [webhook signature verification](https://docs.stripe.com/webhooks/signature), [customer portal](https://docs.stripe.com/customer-management).
