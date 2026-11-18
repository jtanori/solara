# Paid reading editions — approved implementation contract

The operator approved the product-development plan in this session. This document
records the implemented Solar contract, not deployment approval or evidence that
live generation is ready. [ADR 011](decisions.md#adr-011--solar-return-first-and-a-shared-four-product-offer)
and the [Solar completion plan](plan-solar-return-completion.md) amend the development
order and future offer: Solar first, payments next, then any-product lifetime Free
and a larger shared Premium allowance. Those offer changes are not implemented by
this baseline; existing limits and saved documents remain unchanged until a
versioned transition is delivered.

## Product and funding

- A verified owner with an eligible, synchronized subscription explicitly requests
  an edition. Payment success, webhooks, GETs and navigation never generate.
- Implemented baseline: one edition per account per **UTC calendar month**,
  including eligible trials. No rollover, stacking of subscriptions, or reset on
  chart deletion. The approved larger shared allowance is a later tier change.
- Reserve the monthly allowance at acceptance; consume it at the first committed
  provider permit, even if the result fails. Release only a wholly pre-permit
  reservation that has been fenced against subsequent dispatch. This is not a
  Stripe refund.
- A translation or refresh is a new explicit funded edition. A fresh client nonce
  does not bypass the allowance. Replaying an accepted intent returns that run.
- Saved paid editions remain readable/downloadable after cancellation or expiry.
  New dispatch needs current `grantsAccess`, active/trialing status and a future
  period end. Cancel-at-period-end remains eligible until actual expiry.
- Paid-first customers need not consume the lifetime-free offer.

## First vertical slice (#107 / paid #108)

`paid-core-v1` freezes these nine expected sections, in order:
overview, sun, moon, ascendant, aspects, houses, planets, nodes, guidance.

All nine use newly authorized **Placidus** facts and paid editorial contracts.
Never append paid sections to free whole-sign prose. Save a calculation/display
snapshot, including return instant, cusps, placements, angles, aspects, nodes,
natal relationships and policy version. An unsupported Placidus calculation
stops before any permit; no silent house-system substitution.

Use separate runs, allowances, attempts and immutable editions. Do not rewrite
migration 0006, widen its free-only constraints, overwrite `readings.result`,
upsert a saved document, or manufacture content-version changes to avoid its
unique slot. The frozen expected-section manifest, not `tier` or the future
registry, defines completeness. Private validated checkpoints are not editions.

Acceptance means a synthetic entitled owner can request an edition, close the
browser, return to persisted progress, and open/download the same pinned edition.
Free selection, the five block kinds and the bounded page/PDF renderer are reused.
Legacy paid document rows without an authorized paid run are not adopted.

## Durable execution

A database queue is the accepted request. A trusted separately running worker
claims a fenced lease. Browser disconnect never cancels accepted work. No
request-lifetime `after()`, untracked promise or GET-triggered resume.

Lock ordering is lifecycle lease → verified user → owned chart → consent → shared
dispatch control → run/allowance → attempts. Webhook subscription writes take the
same user fence after their existing per-subscription advisory lock. Workers never
take that advisory lock. No generation transaction spans provider HTTP.

At most one active run/account, one outstanding attempt/run, and primary plus at
most one repair/expected section. Each attempt prepares a bounded request,
commits its permit, rechecks authorization, sends, then settles. Validate and
record section output with its receipt atomically. Check all models (including
strong guidance), aliases, input limits, prices and worst-case primary+repair
cost before admission. The cumulative ceiling is 10,000,000 micro-MXN/run;
never clamp real spend or reset it across workers.

Recovery may resume only from settled, validated checkpoints. A reserved or
unknown attempt is potentially billable and must never be replayed. Unresolved
exposure blocks another paid run, even next month or after deleting the chart.
Ten-minute active-job deadline; bounded queued reservation and worker lease.
Global, paid and shared revisioned controls are checked on every permit. Paid
misconfiguration must not disable a valid free configuration.

Explicit stop fences future permits and signals transport. Consent withdrawal,
chart/account deletion, stop and browser closure have distinct outcomes. Record
late receipts without authorizing publication or replay. Withdrawal/deletion
prevents publication. Entitlement expiry stops new dispatch; already recorded
sections can finalize under the original consent if other publication fences
remain valid. Temporary checkpoint prose is removed on terminal finalization;
financial receipts contain no raw provider bodies.

## Following slices

- #110: an additional frozen eleven-section profile, not mutation of nine-section
  editions. Traditional whole-sign annual profections use the natal Ascendant,
  the age attained in the selected return year and traditional rulers. Transit
  reference is the frozen solar-return instant, never worker wall clock. Extend
  types, outbound allowlist, disclosure, availability, prompts and fixtures as
  one change; unsupported facts are explicit limitations.
- #109: versioned bilingual evaluation corpus, model/prompt/schema differences,
  cost/latency/repair evidence and specificity/fact agreement/consistency/tone
  rubric. Proposed minimum is six complete editorially reviewed reports per
  locale. Approval is pinned to profile/contentVersion/locale/provider-model
  configuration and fails closed on changes. No fabricated approval, and no
  additional-human or independent-GitHub-identity gate.
- Development order is now Solar completion → payments → Free/Premium (ADR 011).
  #143 is explicitly the **first post-production follow-up**, not a pre-purchase
  gate and not a fixed defect. #10 ordinary Stripe test lifecycle, genuine-provider
  evaluation/privacy and necessary migration/runtime/executor qualification remain
  release work. Auth/mail acceptance testing waits until the other critical
  features are complete; working signup/recovery is still needed before launch.

## Verification and rollout

Use disposable loopback PostgreSQL, synthetic subscribers and fake provider
transport. Exercise real handlers and transactions, concurrent intents/leases,
crash boundaries, stop/withdrawal/expiry/deletion, unknown spend, strong models,
manifest completeness, pinned HTML/PDF and free preservation. Mutation-test the
claimed guards, restore the baseline, then run the authorized full validation.
Never report an unrun check as passing.

All generation switches and the new shared paid control default off. No live
provider calls, hosted migration, workflow dispatch, production change, or paid
marketing activation is authorized by this implementation approval. Apply only
additive migrations via the existing release procedure. Old ungated binaries are
not a safe rollback; use disablement plus a compatible forward fix.
