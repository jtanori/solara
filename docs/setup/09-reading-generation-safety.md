# Reading generation safety: disabled rollout and recovery

**This is a runbook, not permission to deploy or enable generation.** The free
safety boundary and canonical page/PDF are implemented. Hosted operations,
credentials and live-provider evaluation require separate authorization. Paid
immutable editions, their separate worker/allowance and editorial gate are
covered by [the paid runbook](10-paid-readings.md). See the historical
[approved free-safety plan](../plan-reading-generation-safety.md),
[PR #148 repair evidence](../reading-generation-review-fixes.md), and
[historical initial evidence](../reading-generation-safety-verification.md).

## Contract and current limits

- Saving a deterministic chart never dispatches AI or consumes the offer.
- One free AI interpretation **ever per verified account ID**, not per month,
  browser, chart, locale, model or content version. Initial chart/language remain
  canonical. A deleted account is not tracked using a permanent email fingerprint.
- The first committed dispatch permit consumes the offer even when no usable
  prose results. A positively unsent attempt can release money, not the allowance.
- Every primary and repair requires current processor-policy consent, a fenced
  owned run and a durable reservation. Unknown billing retains exposure and halts.
  HTTP/provider error responses also halt, even with a valid measured receipt:
  billable work is not necessarily successful output or a repair opportunity.
- Free ceiling: **5 MXN**. Paid editions have a separate durable endpoint/worker,
  **10 MXN** exposure ceiling and monthly allowance; none resets the free offer.
  Existing Premium access remains; subscribers may choose an unused free offer.
- Attempts: at most four free calls, 2,000 output tokens each; full verified
  billable-input contract reserved. 15-second maximum attempt timeout includes
  the body; 40-second dispatch budget, 45-second durable run, 60-second route.
- Hourly throttles: generation 10/user and 20/IP, consent changes 20/user, chart
  deletion 30/user. Status is 60/user/minute. Chart deletion has a separate bucket
  and cannot spend consent-withdrawal quota.
- Live service uses per-run memory and owned documents, **not** `generation_cache`.
  Account deletion cascades new consent/run/attempt state. Reading deletion keeps
  a consumed tombstone. Legacy shared cache and existing audit retention remain
  separate #82/#85 work; do not promise full erasure of those legacy stores.
- The reading page/PDF distinguish illustrative chart notes from pinned generated
  documents. Free canonical selection and explicit paid-edition selection never
  generate. **Do not enable the public feature without separately authorized
  provider/editorial evidence and runtime qualification.**

## Configuration inventory (all three env examples agree)

| Variable | Requirement |
| --- | --- |
| `READINGS_GENERATION_ENABLED` | Leave empty or `false`; only exact `true` enables dispatch. |
| `READINGS_PROVIDER` | Account path accepts `chat-completions`, never fixture fallback. |
| `READINGS_PROCESSOR_PROFILE` | Non-secret JSON: stable ID, actual processor name, privacy version, per-model full billable-input caps, explicit served-model aliases. |
| `READINGS_API_BASE_URL` | Canonical HTTPS endpoint base; no credentials/query/fragment; redirects refused. Endpoint changes invalidate prior consent. |
| `READINGS_CHEAP_MODEL` | Explicit live model ID for free sections. |
| `READINGS_STRONG_MODEL` | Required for paid guidance; paid preflight also validates its aliases, prices and input cap. Not used by free sections. |
| `READINGS_MODEL_PRICES` | Explicit positive MXN per million input/output tokens, requested model and every served alias; aliases must currently have equal rates. The full input-cap + 2,000-output-token quote must be representable and ≤5 MXN before availability/claim. No fixture defaults for live work. |
| `READINGS_REQUEST_TIMEOUT_MS` | Integer 1–15000; unset defaults to 15000. |
| `READINGS_API_KEY` | Nonblank visible ASCII without internal whitespace; surrounding spaces are trimmed, controls including CR/LF/NUL are rejected. **Last stage only**, directly in the approved environment's secret manager. Never in chat, Git, local customer data, or a command transcript. |

An input cap is a verified processor billing contract, **not** `characters / 4`.
Validate schema compatibility, full input framing/billing, prices/FX, model aliases
and provider terms in the separately authorized real-provider evaluation. Synthetic
receipts do not establish invoice accuracy, model quality or real latency.

## Generation-off cutover (future authorized operation)

1. Pin the reviewed SHA and target environment. Keep generation off on **every**
   serving old/new deployment and isolate preview databases. No old ungated binary
   may remain a public entry point. Stop/drain old dispatches and verify this; a
   flag change on one deployment or an assumed 60-second wait is not proof that an
   older headers-only timeout stopped its body/network work.
2. Rehearse backups/restore and schema upgrade on disposable representative data.
   Classify legacy provenance **before migration**. The approved exception gives
   unused status to accounts without surviving qualifying genuine free evidence;
   it does not prove they never made a deleted/failed/unpersisted request.
3. Produce aggregate-only counts using the query below. The qualifying bucket
   still needs operator provenance review: a syntactically valid model ID is not
   an invoice. Known fixtures, mixed/unknown test provenance and ambiguous data
   must be classified before proceeding. Do not dump birth data or prose into
   evidence. Halt rollout if provenance cannot be decided under the approved rule.
4. Migration `0006` adds three tables; it adopts the earliest qualifying surviving
   free document per user (creation time, then document ID), preserves other docs,
   and invents no historical consent/prices/usage. Locales other than exact `en`
   or `es`, empty/non-string model IDs, fixture-prefixed IDs (case-insensitive), or
   sections without matching model provenance do not qualify. Unsupported-locale
   documents stay unchanged for classification; an earlier such document cannot
   outrank a later qualifying document. No prior applied/hosted migration was
   edited. `0006` belongs to the earlier free-safety change; the paid additions
   are `0007` and `0008`, described in the paid runbook.
5. Use the existing exact-SHA staging preflight (`db-remote.ts --pr <number> --env
   staging`) and migration/deploy flow only after authorization. At the current
   schema, check nine journal entries, no unexpected/pending hashes, **24 tables /
   147 required columns / 22 required indexes**, `/api/health` and `/api/ready`. Do not bypass
   migration checks or add a second-approver enforcement gate.
6. Keep the flag off through rollout. Smoke authenticated chart save, reading,
   PDF, dashboard, consent withdrawal, status, origin rejection and no-store
   headers in en/es. Verify actual browser interaction and deployed prompt assets,
   function duration/cancellation, and shared pool limits. Local HTTP smoke is not
   hosted/browser proof. Refresh counts to reconcile any late legacy document;
   no implicit generation or bulk cache warming.
7. Any production promotion remains separate: authorized db-remote rehearsal,
   then `deploy.sh --env production`, **without `--skip-migrate`**.

### Aggregate legacy classification (read-only, works before `0006`)

```sql
WITH evidence AS (
  SELECT r.user_id,
    (d.locale IN ('en', 'es')
      AND jsonb_typeof(d.document->'models') = 'object'
      AND d.document->'models' <> '{}'::jsonb
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(CASE
          WHEN jsonb_typeof(d.document->'models') = 'object'
          THEN d.document->'models' ELSE '{}'::jsonb END) m
        WHERE jsonb_typeof(m.value) <> 'string'
          OR (m.value #>> '{}') !~ '^[A-Za-z0-9._:/-]{1,128}$'
          OR (m.value #>> '{}') ILIKE 'fixture%')
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE
          WHEN jsonb_typeof(d.document->'sections') = 'array'
          THEN d.document->'sections' ELSE '[]'::jsonb END) s
        WHERE s->>'status' = 'generated'
          AND jsonb_typeof(d.document->'models'->(s->>'key')) = 'string')
    ) IS TRUE AS qualifying,
    EXISTS (
      SELECT 1 FROM jsonb_each_text(CASE
        WHEN jsonb_typeof(d.document->'models') = 'object'
        THEN d.document->'models' ELSE '{}'::jsonb END) m
      WHERE m.value ILIKE 'fixture%') AS fixture
  FROM reading_documents d JOIN readings r ON r.id = d.reading_id
  WHERE d.tier = 'free'
)
SELECT count(*) AS surviving_free_documents,
       count(*) FILTER (WHERE qualifying) AS qualifying_documents,
       count(*) FILTER (WHERE fixture) AS fixture_or_mixed_documents,
       count(*) FILTER (WHERE NOT qualifying AND NOT fixture) AS ambiguous_documents,
       count(DISTINCT user_id) FILTER (WHERE qualifying) AS qualifying_accounts,
       (SELECT count(*) FROM users u WHERE NOT EXISTS (
         SELECT 1 FROM evidence e WHERE e.user_id = u.id AND e.qualifying
       )) AS accounts_without_qualifying_evidence
FROM evidence;
```

## Diagnosing an outcome without refunding/replaying it

| Public state | Meaning / safe action |
| --- | --- |
| `unused` | No consumed permit. Explicit opt-in can resume an expired wholly pre-dispatch run using its original ID/locale; a deleted unused chart may rebind. |
| `in_progress` | Owner still within deadline; 202 plus `Retry-After: 3`. Use status GET, never automatic POST retry. |
| `completed` / `partial` | Frozen canonical document identity. Model/locale/consent changes cannot regenerate it. Partial failures remain explicit. |
| `failed` | Consumed offer with no published usable document; retain receipt/ledger. No automatic refund. |
| `indeterminate` | Outstanding/unknown dispatch or accounting failure. Keep the reservation and used marker, investigate; do not retry. |
| `free_reading_deleted` | Canonical reading was deleted after consumption; do not allocate another offer. |

After a claim, a wholly pre-permit generation failure returns an explicit error
(409 for missing consent, 404 for a deleted chart, otherwise a stable 503 code),
not a successful `unused` response. Finalization still clears the unused
claim's owner; GET can report `unused` and an explicit later request can recover
the same offer. This does not refund or replay a consumed permit.

Read-only aggregate diagnostics (amounts are **micro-MXN**, not provider invoices):

```sql
SELECT status, count(*) FROM reading_generation_runs GROUP BY status;
SELECT state, count(*), sum(reserved_micros) AS admitted_micro_mxn,
       sum(cost_micros) AS settled_micro_mxn
FROM reading_generation_attempts GROUP BY state;
```

`reserved` has no receipt, `unknown` retains estimated exposure, `measured` stores
validated usage/cost for a served model admitted by that attempt's requested-model
contract, and `not_dispatched` is positively unsent. Its diagnostic code preserves
the actual permission/configuration/deadline failure rather than labelling every
failure cancellation. Latency is rounded nonnegative monotonic elapsed time;
wall-clock corrections cannot invalidate a receipt. Real overruns are recorded,
not clamped. Report unknown/reserved separately from measured spend.
Use existing redacted logs and stable codes; never log prompts, keys or provider
bodies. Manual invoice reconciliation/credited retries need an explicitly reviewed
future policy, not ad-hoc updates that clear `consumed_at`, delete attempts or raise
ceilings. A lost response and an all-fallback document are not proof of zero cost.

## Recovery and activation boundary

First disable new dispatch on all instances and inspect durable outcomes. Preserve
consent revisions, frozen docs, attempt reservations and consumed tombstones.
An additive migration does **not** make old binary rollback safe: old readiness
rejects the new journal hash, and old chart-save code bypasses these safeguards.
Recover by a schema-compatible forward fix (generation off) or a separately
rehearsed restore; never drop the ledger to make readiness green.

Secrets and an isolated synthetic live evaluation come only after separate
approval. Public generation stays off until provider evaluation, page/PDF output,
privacy/retention work and hosted/browser checks are ready. None of those follow
from a local green suite or an author self-review.
