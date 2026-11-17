# Reading generation safety — implementation plan

**Scope:** execution-order step 1: consent (#105), the lifetime-free allowance in
#104/#108, provider/accounting failures (#129), and regression evidence (#128).
**Inspected base:** `staging@2c0c64b202fdbf7a9e8f7d91aadc8b950866f14e`.
**Working branch:** `arena/83b33a0a-solara` (fixed Arena branch).
**Status:** approved defaults implemented with generation disabled; local synthetic verification and author self-review recorded in [the verification report](reading-generation-safety-verification.md). Browser interaction QA remains unverified. Hosted rollout and live-provider evaluation remain unauthorized.

This plan does not enable generation, request credentials, run migrations, or
change issue states. Real-provider configuration and secrets are the final stage.
It is a scoped design, not a replacement backlog or a claim of issue completion.

## 1. Outcome and boundaries

A verified account can explicitly authorize one free AI interpretation of one
owned chart. Concurrent requests cannot buy duplicate provider work. Every
potentially billable attempt has durable budget coverage before it starts.
Withdrawal, deletion, uncertain provider outcomes, and process crashes cannot
silently reopen the allowance or start unaccounted work.

Keep deterministic chart creation, existing saved readings, and the current PDF
working when generation is disabled or unavailable. Keep generation **off by
default** throughout implementation and initial rollout.

### Scope-to-acceptance map

| Requirement | This change must deliver | Deliberately not included |
| --- | --- | --- |
| #105 | Versioned, named-processor consent; explicit UI; server enforcement; withdrawal; payload/privacy tests | General legal pages, retention/export implementation in #82/#85 |
| #104/#108 lifetime rule | One free AI reading per verified account; repeat requests reuse its identity; durable concurrency and deletion protection | Full teaser/page/PDF presentation; paid subscription volume policy |
| #129 | Real adapter + pipeline failure accounting; durable reservations; stop on unmeasurable spend; tests for both tiers | Live provider evaluation or an assumption about actual invoices |
| #128 | Primary/repair regression coverage and freshly executed mutation evidence | Closing the issue because tests merely exist |

No paid-generation endpoint, checkout change, Stripe setup, new job platform,
profections/transits, editorial tooling, workflow/ruleset change, or production
promotion belongs here. The generic accounting core is tested for free and paid
budgets, but production authorization in this slice permits only the lifetime-free
run. #104 and #108 remain broader than this slice and must not be closed wholesale.

## 2. What the inspected code establishes

These are source observations, not newly executed reproductions:

1. `src/app/api/readings/route.ts` saves a new chart on every accepted POST and then
   optionally generates `tier: "free"`. There is no consent check or lifetime
   allowance. The hourly limiter is not an entitlement counter.
2. `src/readings/generate.ts` accounts a returned completion, but a thrown provider
   error adds a `provider_error` result and continues without cost. The real
   `chat-completions` adapter throws for missing/invalid usage. Its repair catch
   similarly loses any charge represented only by the failed adapter call.
3. `chat-completions.ts` sends `max_tokens = maxOutputTokens + 256`; the current
   quote uses only `maxOutputTokens`. Input estimation is `text.length / 4`, not a
   guaranteed bound on the full HTTP request's tokenized input.
4. The adapter clears its abort timer after `fetch()` resolves headers, before
   `response.text()` completes. There is no overall run deadline or response-size
   limit. A `Promise.race` alone would not cancel the underlying work.
5. All-fallback documents are intentionally not persisted. Their spend is currently
   only logged by the route; a document/cache row is not a complete attempt ledger.
6. The cache is shared and insert-only. `contentVersion` includes model IDs, but
   not the processor identity/endpoint profile. Identical model aliases on different
   processors must not reuse content accidentally.
7. Reading deletion cascades documents; account deletion cascades readings. A quota
   derived by counting remaining documents would reset on deletion.
8. `next.config.ts` traces prompt assets only for `/api/readings`. Moving dispatch
   to a new route requires moving/adding that tracing rule and checking the build.
9. Both `src/lib/readiness.ts` and `scripts/db-run.ts` hard-code the tables included
   in column introspection. Updating only `schema-verification.ts` would be incomplete.

The later decision in `docs/plan-readings-engine-epic.md` §9b is authoritative for
this plan: **one free reading per user, ever**, with a repeat returning the existing
reading. The older monthly-free wording in #108 needs reconciliation, not a second
free quota. The old reading amendment's advice to throw away missing usage must
also be superseded by explicit uncertain-spend handling.

## 3. Non-negotiable invariants

| ID | Invariant |
| --- | --- |
| S1 | No provider call without a committed permit that rechecked the live verified user, owned reading, active matching consent, entitlement, and durable budget reservation. Withdrawal races use the explicit permit semantics in §7. |
| S2 | A public caller cannot select another user, a paid tier, arbitrary processor/model, a budget, or a trusted digest. Facts are computed server-side from the owned chart. |
| S3 | One lifetime-free run identity per user, enforced in PostgreSQL, not by cookies, an in-memory lock, a document count, or a read-then-insert race. |
| S4 | Every primary and repair dispatch passes through the same authorization/accounting boundary. No optional no-op guard in production. |
| S5 | Possible external work is never treated as definitely free. Unknown spend stops the run, preserves its reservation, and cannot be replayed automatically. |
| S6 | Budget is cumulative across all attempts for the same run. A new HTTP request, process, model version, or locale cannot reset it. |
| S7 | Consent withdrawal prevents newly authorized dispatches; already-authorized external work is bounded and explicitly acknowledged. No new prose/cache publication after withdrawal wins the finalization race. |
| S8 | Database ownership/fencing is rechecked at admission and publication. No PostgreSQL transaction or checked-out application connection spans LLM I/O. |
| S9 | Deleting a reading does not restore a consumed allowance. Deleting an account removes the new linked consent/run/attempt state and prevents a late worker from recreating it; existing audit/cache retention is described separately, not claimed erased. |
| S10 | Public errors, logs, and accounting records contain no credentials, raw birth input, complete prompts, or provider response bodies. Estimates are labelled estimates, not receipts. |
| S11 | Disabled or unconfigured generation makes zero external calls and does not newly consume an unused allowance. Deterministic chart access remains available. |
| S12 | Existing frozen documents are not overwritten, and cache hits cannot bypass consent/allowance admission for a new free document. Reading an already saved document requires no new generation consent. |

## 4. Approved product semantics

The lifetime rule is already decided; the edge cases below make it implementable.
The operator accepted the recommended defaults before implementation.

| Situation | Proposed behavior |
| --- | --- |
| What counts | One **AI interpretation**, not every deterministic chart saved. Saving a chart without generation consumes nothing. |
| Unit of identity | The verified account's `users.id`, across all sessions/devices. No persistent email fingerprint is introduced to track a deleted person. Re-registration abuse remains a separate identity/rate-limit concern. |
| Language | Bind the free run to its initial locale. Changing the UI language does not fund another generation. Show the saved document's language; do not silently regenerate or present it as a translation. Bilingual validation uses distinct synthetic accounts. |
| Repeat/double click | Return the original reading/run and current status, even if the caller submitted a different owned reading. Never silently relabel that result as the new chart. |
| Invalid configuration or no consent | No reservation/consumption; return a safe status and leave the chart alone. |
| Work reserved, but no dispatch authorized and no content published | The same original run can be resumed after fixing the blocker. An expired owner can be replaced only after proving there is no dispatch marker or published artifact. |
| A dispatch was authorized, but the process dies before a receipt | Treat it as possibly billable. Keep the allowance consumed and the budget reserved; do not retry automatically. Exactly-once HTTP delivery cannot be promised. |
| Known provider failure after dispatch | Record the cost/basis and failure. A completed failed run is not silently reset to a fresh free run. Any future credited-retry policy must reuse its identity and retained spend, not delete the ledger. |
| Cache-only successful document | Consumes the one free interpretation even though current-run network spend is zero. |
| Partial success | Freeze the generated sections with explicit failure status for the rest. Do not repeatedly repair a partially published free reading on every page load. |
| Reading deleted after consumption | Keep the used marker with a nullable reading reference; explain that the original was deleted. Do not return an inaccessible ID or mint another allowance. |
| Reserved chart deleted before any permit/publication | The allowance stays unused. An explicit later request may rebind that same unconsumed run ID to an owned chart under the same locks and fresh consent; it cannot erase any attempt or recreate a consumed allowance. |
| Consent withdrawn/re-granted | Existing documents stay; new dispatches stop. Granting again never resets a consumed allowance. A wholly pre-dispatch run may resume after fresh consent. |
| Existing free documents | Adopt one deterministic canonical document/reading per account as already used; preserve additional legacy documents, grant no consent retroactively, and do not rewrite historical costs as verified receipts. Classify fixture-only documents separately before deciding they consumed a real interpretation. |
| Unrecoverable legacy history | Proposed one-time cutover policy: an account with no surviving genuine generated document starts unused. This includes history the old system cannot reconstruct, not proof that the account never generated. The operator accepted this cutover exception before implementation. |
| Existing paid subscribers | Preserve existing chart/subscription/PDF access. They may explicitly choose the same one-time free AI offer if unused; do not silently spend it as a substitute for a paid-generation request or imply paid AI orchestration is already implemented. |

The confirmed defaults include **chart-only saves do not
consume the offer**, **initial-locale binding**, **no automatic refund/replay after
a possibly billable attempt**, and the **legacy cutover exception**. They favor
safety without claiming either that a successful reading was delivered when it
was not, or that missing historical records prove no previous use. If strict
retrospective lifetime enforcement allows no exception, legacy eligibility needs
a different approved rule; no migration should guess it.

## 5. Architecture and API boundary

### Separate chart saving from explicit generation

Remove the implicit LLM dispatch from `POST /api/readings`; retain its existing
chart validation, authentication, rate limiting, and `{ id }` response. The wizard
continues to save charts without requiring AI consent.

Add one server orchestration entry point (proposed
`src/readings/generation-service.ts`) and the following thin routes:

| Route | Contract |
| --- | --- |
| `GET /api/readings/consent` | Authenticated, private/no-store policy descriptor and this user's consent status/revision. No keys or raw API endpoint. No dispatch. |
| `PUT /api/readings/consent` | Explicit grant of the server's current policy/processor, with expected revision. Reject stale/unknown versions or a false/missing affirmative choice. Granting alone never generates. |
| `DELETE /api/readings/consent` | Idempotent withdrawal; advance the consent revision so an older in-flight grant cannot silently re-enable consent. No entitlement reset. |
| `POST /api/readings/[id]/generate` | Authenticated, ownership-scoped request for the one free run. Server chooses tier, processor, policy, models, and limits. Uses the orchestration service. |
| `GET /api/readings/[id]/generation` | Private/no-store, ownership-scoped status. Reads only: polling never starts, resumes, or retries provider work. |

Use the existing origin guard and rate-limit helpers; add explicit policies for
consent mutation and generation admission. Rejected requests must reach zero
provider calls. Foreign reading IDs produce 404 without revealing another user's
allowance. A legitimate repeat on an owned reading returns the caller's own
canonical ID with an explicit `existing` result, not somebody else's state.

Responses distinguish `completed/existing` (200), `in_progress` (202 with bounded
Retry-After), `consent_required`, `generation_disabled/unavailable`,
`free_reading_deleted`, and `failed/indeterminate`. Do not expose upstream response
text. The exact UI messages are localized; codes are stable. Returning a status
is not evidence that the worker completed. Once ownership is established, returning
an existing frozen result is a read/no-op: a later disabled flag, stale consent,
or changed model configuration must not hide it or force fresh consent to read it.

Keep execution bounded and synchronous for the admitted POST in this slice; only
a competing request receives `in_progress` while the owner is working. Do not
return early and launch an untracked promise, assume a serverless process survives
a response, or turn polling into a hidden retry/queue. A host timeout leaves the
durable attempt state for the explicit recovery rules below.

Minimal UI belongs here because #105 needs an actual consent action:

- A small reading-generation control on the owned reading page: named processor,
  exact data disclosure, selected language and one-free rule, an unchecked consent
  control, and an explicit generation action. No opt-in buried in signup.
- Withdrawal in the dashboard profile area, including when generation is disabled.
  `/account` redirects signed-in users, so it is not the settings location.
- Existing charts/notes remain usable. Do not call legacy notes “your AI output.”
  Full document and PDF rendering stays in #104/#106; public activation must not
  misrepresent this incomplete presentation as a finished reading product.

### One production dispatch path

The service owns authentication/consent/entitlement and durable accounting.
`generateReadingDocument` remains the testable section orchestrator, but it must
receive a required execution context whose admission and settlement operations
are bound to the persisted run. Production cannot default that context to a no-op.
Tests supply an explicit in-memory equivalent or a real PostgreSQL implementation.

The raw adapter is a transport, not an authorization bypass. Audit all production
imports/callers, and test the actual HTTP handler → service → real adapter with an
injected fake HTTP transport. A static import test is supplementary, not the proof.

Use a per-run in-memory section cache/staging area for the new live path and
publish the frozen document only in the fenced finalization transaction. Do not
read or write the current cross-account persistent cache in this path: it has no
user/reading provenance for erasure (§9). Existing saved documents provide repeat
reuse without another provider call. Keep the generic cache interface and its
fixture/DB regression tests; cache hits still cannot bypass consent/entitlement
or cause historical generation costs to be billed again to the current run.

## 6. Persistence: three additive responsibilities

Final names may change during implementation, but these responsibilities and
constraints may not be replaced with process memory.

### A. `reading_generation_consents`

One current-state row per user, FK to `users` with account-deletion cascade:

- Server-issued receipt ID, policy version, named processor ID, monotonically
  increasing revision, granted/withdrawn timestamps, and disclosure locale.
- Consent changes serialize on the user/current-state row. A stale grant uses
  compare-and-set on the expected revision; withdrawal creates a revoked state
  even when there was no prior grant, preventing a delayed initial grant race.
  Repeating an already effective withdrawal is a no-op, not another grant/event.
- Record grant/withdrawal events through the existing audit mechanism with the
  opaque receipt ID, policy/processor identifiers and no birth data, IP, secret,
  prompt, or duplicate user ID in `target`. Preserve version provenance rather
  than silently overwriting it. Keep the existing non-null-at-insert actor/FK
  discipline and `ON DELETE SET NULL` audit behavior; do not redesign account
  deletion's established audit rules.
- No automatic backfill of active consent.

### B. `reading_generation_runs`

This durable run also owns the lifetime-free claim; no separate document-count
quota or duplicate lease subsystem:

- Run ID; user FK; kind `lifetime_free`; owned reading/document references;
  initial locale; content and processor-policy versions; consent revision;
  owner token/deadline; status; consumption/start/end timestamps.
- Unique partial index on user for `kind = 'lifetime_free'`, independent of
  reading ID, locale, model, content version, and status. No expiry or cleanup
  deletes a consumed claim. Public code cannot introduce a paid kind here.
- Reading/document FKs use nullable references with `ON DELETE SET NULL`, while
  the user FK cascades. This preserves the allowance after individual deletion
  without retaining deleted chart content.
- Budget/usage units and state constraints are explicit. Preserve a legacy-adopted
  state for preexisting documents without inventing a provider receipt.

State transitions are explicit: unallocated → reserved → running → terminal
(completed, partial, failed, or indeterminate); legacy adoption starts terminal.
`consumed_at` becomes sticky at the first committed dispatch permit or cache-only
publication. A terminal run cannot return to unallocated. Reading deletion clears
references, not the claim. Ownership may be replaced only in the wholly
pre-dispatch, unpublished reserved state. A local error with no permit/publication
leaves a retryable reserved/unused run (or no row), not a permanently consumed
terminal failure. Rebinding a deleted, wholly unused chart is the narrow exception
to the original-reading binding, never permission to reuse an admitted attempt.

Keep execution/content outcome and billing basis distinct. A halted run with
validated earlier sections may publish a **partial** document if final consent,
ownership, and durable accounting checks still pass; unknown billing remains
labelled unknown. A failed ledger write cannot be disguised as successful partial
publication. This also prevents a partial document from implying all calls were
successfully priced.

Pin the run to the immutable owned chart and its chart version, locale, content
version, processor profile, models, and pricing snapshot. Compute the digest in
memory; do not copy birth input or chart content into the run/attempt ledger.
Individual deletion clears chart/document references but leaves the minimal used
marker and billing metadata. Before the first dispatch, a blocked reservation may
be re-prepared only under a fresh owner and matching consent. After dispatch, a
change of configuration is a stop/reconciliation condition, not a way to mix
policies or regenerate the original free reading.

### C. `reading_generation_attempts`

A durable row for each primary/repair admission, FK to run with cascade:

- Unique `(run_id, section, phase)` for admitted primary/repair attempts;
  request/attempt ID; owner token; requested/reported model; processor and pricing
  snapshot identifiers; payload-policy hash (no prompt/content hash or body);
  reserved cost; measured cost when known; finite integer usage where valid;
  outcome/billing basis; timestamps. Complete all local configuration/serialization
  checks before creating the marker. Do not reuse a potentially dispatched slot.
- At most one outstanding external attempt per run. Enforce valid state changes
  using conditional writes and affected-row checks, not a last-write-wins update.
- The attempt marker commits **before** the adapter may dispatch. A crash between
  that commit and HTTP is deliberately ambiguous, not proof of zero spend.
- Settlement and summary updates are idempotent and transactional. Lost owners
  cannot refund reservations, authorize later attempts, or publish content.
- Metadata/ledger rows survive an all-fallback result or final-document write
  failure. Log lines alone are not the spend record.

Use integer micro-MXN for new admission balances, with explicit rounding and
bounded numeric conversion. Preserve existing document compatibility; add labelled
accounting-basis metadata rather than silently redefining old `costMxn` or
`wastedCostMxn`. The attempt ledger is authoritative for new runs.

## 7. Concurrency, withdrawal, deletion, and recovery

### Admission and finalization order

Reuse `withAccountLifecycleLock` for **short admission/publication scopes**, not
for the whole network run. It already coordinates with account deletion and works
through transaction pooling. Do not introduce session advisory locks.

Inside a short transaction, use a consistent order:

1. Fence the account lifecycle lease where the scope uses it.
2. Lock/re-read the live user; verify the authenticated actor is still admissible.
3. Lock/re-read the owned reading.
4. Lock/re-read current consent.
5. Lock the lifetime run, then its attempt rows.

Consent-only changes lock user → consent and never acquire the lifecycle lease
while holding those rows. Reading deletion uses the same lifecycle/user/reading
order before clearing/terminating the associated run. Account deletion already
uses lease → user; preserve that ordering and its audit/FK guarantees.

A foreign row must be rejected before locks expose its state. Use database time
for deadlines/state ownership, bounded lock/statement waits, and verify affected
rows. Release connections before calling the provider. Existing checkout and
account deletion tests must still pass; this work must not undo #142's pool split.

### Race semantics (the contract must be honest)

The committed dispatch permit is the linearization point. If withdrawal/deletion
commits first, admission fails. If a permit commits first, that **one** call may
already be in flight or about to be sent. No database design can atomically revoke
bytes from an external server.

Recheck before invoking the transport and at each later await boundary, but do not
claim that check eliminates the final scheduling/network race. Withdrawal stops
all subsequent primary/repair admissions. Abort the local transport on known
cancellation/deadline; an abort is not proof the vendor did not charge.

Final publication rechecks user, ownership, owner token, matching active consent,
and run state. If withdrawal/deletion won, discard new prose and new cache writes.
Accounting may still settle an already authorized attempt while the account/run
exists, without restoring consent or enabling another dispatch. If account deletion
removed the rows, never recreate them; only emit a non-content operational outcome.

### Recovery rules

- A stale reservation with **no dispatch marker and no publication** may be
  reclaimed on an explicit POST for the same canonical run, with a fresh owner
  and consent check. The old owner then fails every conditional write.
- Any unresolved dispatch marker is possibly billable. Do not retry it after a
  timeout, restart, expired owner, or missing document. Return an indeterminate
  status and retain its budget/consumption.
- A receipt or ledger write failure halts further calls. The committed reservation
  protects against the process dying before settlement can be recorded.
- No GET, cleanup timer, deployment, or consent re-grant resets a used claim.
- A technical reconciliation path may later use positive provider evidence; this
  is not a human-approval enforcement gate and not permission to refund by guess.

## 8. Provider protocol and spending rules

### Classify billing independently from output validity

Change the provider outcome contract to distinguish:

| Outcome | Accounting and control |
| --- | --- |
| Definitely not dispatched | Only local, positively known pre-dispatch failure qualifies. Release that reservation; no external charge is asserted. |
| Measured response, valid or invalid content | Preserve valid usage and the priced served model even if content is absent, malformed, rejected, or truncated. Settle measured spend before deciding whether one repair is allowed. |
| Dispatched/uncertain, no trustworthy usage or model price | Preserve the conservative reservation, label the amount estimated/unknown, halt the run, discard unusable output, and do not replay. |

Releasing a monetary reservation is not resetting the product allowance. Under
the proposed irreversible-permit policy, even a positively unsent outcome found
after permit commit does not automatically create a new free offer. All ordinary
local preflight checks therefore belong before that commit; any future credited
retry must be an explicit policy using retained history, not a deleted marker.

An unexpected exception after handing control to the adapter defaults to
uncertain, not definitely free. A 4xx/5xx, disconnect, body parse error, abort,
or missing usage does not prove zero billing. Do not put real-looking zero token
counts into an error result. A vendor-specific zero-billing classification requires
an explicit supported contract, not the HTTP status alone.

A malformed primary output with measured usage may get **one** repair. It needs a
new permit and its actual longer prompt budget. For #128, an unusable repair must
leave the original `invalid_output` reason intact and retain the primary's measured
spend plus the repair's measured or uncertain exposure. Keep run-level halt and
billing basis separate from that section failure reason.

### Reserve the request actually sent

- Build/prepare the complete outbound payload once; quote that payload and send
  those same bytes. Include system/user messages, schema overhead, and repairs.
- Remove the hidden `+256` output headroom; `max_tokens` must equal the output cap
  admitted by the budget. If an adapter later needs a different cap, it must quote
  that exact cap rather than quietly enlarging it.
- Do not call `text.length / 4` a hard upper bound. Each supported live processor/
  model profile must supply a defensible tokenizer/metering bound for the full
  request, including framing. A documented conservative UTF-8 bound is acceptable
  only for a tokenizer/profile for which it is valid. Unknown profiles fail closed.
  Fixture estimates are useful tests, not live billing evidence.
- Snapshot model rates in MXN per million tokens for the run. A real provider may
  not fall back to `fixture-1` or fixture prices. Non-finite, negative, out-of-range,
  missing, or currency-ambiguous configuration refuses dispatch.
- Missing/changed served-model identity is not silently priced as the requested
  model. Explicitly allow and price known aliases in the processor profile;
  otherwise mark unpriceable, reserve, and halt.
- Validate usage as finite non-negative safe integers, with required primary
  usage fields and no contradictory totals. Do not accept booleans, numeric
  strings, fractions, overflow, or absent data as zero. An all-zero receipt on a
  supposedly billable request is untrusted unless that processor contract can
  establish why it is legitimate.

Admission uses the cumulative durable balance:

```text
measured spend + retained estimates + outstanding reservations + next quote
    <= run ceiling
```

The free ceiling stays **5 MXN**; the existing **10 MXN** paid budget is tested at
the core level only. A valid receipt replaces, rather than adds to, its reservation.
If actual usage/cost exceeds the admitted bound, retain the true value, halt and
report the breach. Never clamp the receipt to make a ceiling test pass. Estimates
and stopping rules cannot guarantee an arbitrary vendor's invoice; supported rate/
token contracts must be established before live activation.

### Bound transport and total work

- Abort coverage lasts through headers **and the complete bounded response body**.
  Reject redirects to avoid sending credentials/data to a different processor.
- Compose request-disconnect, whole-run, and per-attempt cancellation signals.
  Abort/cancel the body reader, clear timers in the outermost `finally`, and check
  ownership/authorization before any later dispatch or publication.
- No automatic transport retry. Schema repair is separate, visible, budgeted work.
- Proposed initial bounds: 15s per attempt, 45s overall, settlement time reserved
  within that overall budget, 256 KiB maximum response, and at most four free-tier
  calls (two primary + two repairs). Confirm the hosting duration can contain the
  run plus response margin; do not increase it by assumption.
- Validate timeout values as finite positive bounded integers. Do not accept
  `NaN`, zero, negatives, or infinite environment values. Slow-model performance
  is evaluated later; it is not a reason to silently remove deadlines now.

## 9. Consent identity, privacy, cache, and logs

`chat-completions` is an adapter name, **not the named data processor**. Introduce
an explicit non-secret processor profile/descriptor: stable ID, display name,
canonical allowed endpoint origin/path, policy version, supported models/metering,
and en/es disclosure text. An unspecified or mismatched profile refuses live
admission. Tests use a clearly named synthetic profile; do not pretend a provider
has been selected or configured.

The user accepts the current server policy/processor version. A processor or
material data-use change invalidates old consent. A same-processor model change
need not imply a new privacy consent unless the processing policy changes, but
still changes the content/config snapshot and never grants another free run.

Compute the digest from server-held input. Validate an explicit bounded digest
shape and permitted values at the outbound boundary; replace free-form engine
warnings with allowlisted codes/text rather than forwarding arbitrary strings.
Test the **entire outgoing payload**, not only the digest helper, for raw
name/email/birth date/time/place/coordinates, user IDs, cookies, and injected
fields. Do not forward user text as instructions. Repair explanations must use
bounded, allowlisted schema paths/error codes, not echoed provider content or
arbitrary keys/values from validation messages.

The disclosure says derived chart information is sent, not raw identity/birth
fields. It must not promise anonymity or say account-linked interpretations are
“not personal data.” Withdrawal stops future processing; existing documents remain
until ordinary deletion/retention applies. General retention/export decisions
remain in #82/#85, not silently decided by this consent implementation.

Include processor identity and payload/accounting policy revision in
`contentVersion`/cache provenance. A fixture and a live model with the same alias
must not share a new-generation cache identity. Preserve old rows; a version bump
invalidates future cache lookups, not the lifetime allowance or existing documents.
No automatic regeneration/mass cache warming is part of rollout.

The existing `generation_cache` has no user/reading FK, so current account/reading
deletion does **not** erase its rows. Do not claim otherwise. For this slice, the
new live service uses only a per-run in-memory cache plus the owned frozen
document, not shared persistent-cache reads/writes. This is a deliberate temporary
restriction of the earlier shared-cache design, not a new cache platform. Existing
legacy cache rows are neither silently purged nor declared anonymous. #82 must
resolve their retention/erasure and any future cache provenance before shared live
persistence is re-enabled; public privacy copy must disclose the actual policy.

Log stable outcome codes, attempt counts, timing, and labelled cost summaries.
Never persist/log complete prompts, provider bodies, authorization headers, or
secret-bearing URLs. Raw provider messages must not become `failureReason` in a
user-visible document. Test deliberately planted fake secrets through primary,
repair, timeout, body-read, and serialization error paths.

## 10. Migration and compatibility plan

Use an additive migration after `0005` (choose the actual number after fetching the
base at implementation time). Generate/review SQL, journal, and snapshot; never
edit an applied migration. No new dependency is assumed; use the existing pg,
Drizzle, Zod, fetch, and test infrastructure unless a tokenizer requires a separately
justified dependency.

1. Add consent, run, and attempt tables, FKs, uniqueness/check constraints, and
   indexes for user/run/status lookups. Verify account-deletion cascades and
   individual-reading `SET NULL` behavior with real PostgreSQL.
2. Produce aggregate-only classification counts for genuine free documents,
   fixture-only/ambiguous provenance, and accounts without surviving generated
   documents. After approval of §4's cutover policy, adopt the earliest qualifying
   free document per user using deterministic `created_at`/ID ordering. Mark it
   used without inventing consent, historical token usage, or receipt amounts.
   Preserve additional legacy documents. Chart-only history does not consume the
   offer under the proposed rule, but deleted documents and unpersisted failures
   cannot be reconstructed from today's schema; document that exception instead
   of claiming retrospective exactly-once enforcement.
3. Add tables/columns/indexes to `src/lib/schema-verification.ts` and update BOTH
   introspection queries in `src/lib/readiness.ts` and `scripts/db-run.ts`.
   Update manifest, readiness/schema tests, and documented contract counts together.
4. Prove upgrade from the current migrated schema and fresh-database installation,
   including repeated migration and adoption behavior.
5. Keep generation disabled on all serving old/new instances during cutover.
   A new flag value in one deployment is not proof an older instance stopped.
   Drain old dispatches before relying on the new allowance/ledger; reconcile
   any late legacy documents before activation.
6. The implementation is `deploy:required`. A later authorized staging preflight
   must apply required schema before preview readiness; use the existing exact-SHA
   migration/deploy flow, without changing workflows or relaxing gates.

Additive SQL does **not** make arbitrary binary rollback safe: old readiness
rejects unexpected migration hashes, and old code lacks these guards. Recovery is
generation-off plus a schema-compatible forward fix (or a separately rehearsed
restore), not dropping consent/ledger tables or deploying the old ungated code.

## 11. Implementation sequence and affected surfaces

One cohesive safety PR on the fixed session branch, with reviewable commits;
justify its size rather than letting half the safety boundary ship enabled.
Never base this work on the unrelated #140 branch.

| Order | Deliverable | Main surfaces |
| --- | --- | --- |
| 1 | Baseline/reproduction tests and explicit state/outcome contracts | Existing readings adapter/pipeline tests; new safety tests |
| 2 | Additive schema, consent/run store, adoption, ownership/uniqueness | `src/db/schema.ts`, `drizzle/`, schema verification/readiness, `scripts/db-run.ts` |
| 3 | Guarded service + durable attempt admission/settlement + bounded real adapter | Proposed `src/readings/generation-service.ts`, store/policy helpers; `generate.ts`, `provider.ts`, `adapters/chat-completions.ts`, `config.ts`, `document.ts`, `types.ts`, `db-cache.ts`, `content-version.ts` |
| 4 | Consent/generation routes, chart-only creation, minimal opt-in/withdrawal UI, deletion fences | New routes, `src/app/api/readings/route.ts`, individual deletion route, reading page/dashboard, small dedicated controls, rate-limit policies |
| 5 | Runtime packaging and configuration docs | `next.config.ts` prompt tracing for the new route; all three env examples; consent copy/setup notes; scoped corrections to the epic/amendment and AGENTS |
| 6 | Mutation, concurrency, migration, full regression verification and author self-review | Tests listed below, evidence/acceptance matrix, future PR body |

Proposed new test families: consent, free-entitlement concurrency, generation
service integration, attempt ledger, privacy payload, and transport deadlines.
Prefer extending existing test modules when they already own the behavior.
Do not copy the production algorithm into tests.

Known collateral to budget for: tests constructing `GenerateDocumentArgs` need an
explicit execution context; live-service tests must assert it does not access the
shared persistent cache, while existing cache-store regressions remain; corpus
tests need explicit test-run budgets; content-version tests must cover processor
swaps; database cleanup must remove every run/attempt/cache key written. No
secrets or real-network fixtures in `src/`.

## 12. Verification and mutation acceptance

This was the approved acceptance matrix, not evidence by itself. Executed outcomes and limitations are now recorded in [the verification report](reading-generation-safety-verification.md). All automated evidence uses synthetic
charts, fake provider HTTP, and a disposable local database. At least one suite
must use the real handler → real service/store → real adapter; replacing that
chain with a fake provider alone would hide the #129 defect again.

| Test area | Required outcomes |
| --- | --- |
| Authentication/ownership | Unauthenticated, unverified, foreign reading, forged tier/provider/digest requests make zero calls; no cross-user status leakage. |
| Consent | Missing/stale/wrong-processor/withdrawn consent blocks; en/es affirmative grant persists server version/time; stale grant cannot undo withdrawal. |
| Withdrawal races | Pause before permit: zero calls if withdrawal wins. Pause after permit: at most that admitted call, no later repair/section, no post-withdrawal publication; accounting retained. |
| Lifetime concurrency | Two actual DB sessions/process contexts, same user and same/different reading: one run and one call sequence; losers receive the canonical state. |
| Lifetime bypasses | New session, language, content/model version, cache hit, reading deletion, consent re-grant, and process restart cannot grant a second free run. Different users remain independent. |
| Process death | Crash before admission can safely resume the same run; crash after committed attempt but before/after HTTP cannot replay; late owner cannot dispatch/publish/refund. |
| Legacy migration | Empty DB, current schema, multiple old free docs, fixture-only/ambiguous docs, chart-only/deleted history, approved cutover exception, idempotent adoption, no inferred consent, deterministic canonical selection. |
| Actual adapter failures | Missing/negative/fractional/overflow usage, missing/unpriced served model, valid usage with invalid/missing output, non-JSON/HTTP error, connect/body timeout, disconnect. Measured vs unknown outcomes stay distinct. |
| #128 repair | Bad primary with measured spend + repair bad usage/price/error: original invalid-output reason preserved; both exposures retained; no further dispatch after uncertainty. |
| #129 both tiers | A misreporting real-adapter response cannot dispatch the full free or paid section set; estimate/unknown exposure persists; test free and paid explicitly. |
| Exact budgeting | Payload and admitted token caps match; system/schema/repair input included; cumulative reservation/settlement and duplicate callbacks do not double count or reset money; actual overrun is recorded, not clamped. |
| Deadline/body bounds | Headers immediately + stalled body still aborts; oversized stream cancels; total deadline blocks next call; invalid timeout config refuses rather than disabling bounds. |
| Privacy | Capture complete primary/repair HTTP bodies and serialized failures/logs; assert no raw input, user identity, fake secrets, or response-body echo. |
| Deletion | Actual reading/account deletion raced with admission/finalization; allowance survives reading deletion, new linked state cascades with account deletion, no late cache/document/user recreation. |
| Cache/pool boundaries | The real production service does not read/write shared cache rows. With fake HTTP paused after admission, another user's real DB query completes under a deliberately small app pool; no connection/transaction is retained over LLM I/O. |
| Disabled/config failure | Chart save/page/PDF and returning an existing result still function; no new allowance consumption or network calls; no automatic fixture fallback for a misconfigured live provider. |
| Build/runtime | New route's built artifact contains prompt files; origin protection, private/no-store headers and status-only polling remain correct; existing lifecycle/checkout tests stay green. |

### Minimum mutation matrix

Record mutation → named test → observed failure → restored baseline on the final
implementation SHA. A surviving mutation is a test gap, not an evidence checkbox.

- Remove consent check from the new production entry point.
- Skip consent-revision recheck for repair or finalization.
- Allow an old consent grant to overwrite a later withdrawal.
- Remove/relax the unique user lifetime key; run the two-session race.
- Key the allowance by locale/content version, or delete it with the reading.
- Reclaim a run with an unresolved dispatch marker.
- Skip owner/user/reading recheck before admission or publication.
- Publish the document before the final authorization fence, or wire the new live
  service back to the unowned shared persistent cache.
- Skip durable reservation before adapter invocation.
- Treat an adapter throw as zero-cost and continue.
- Drop the repair accounting/usage guard (#128).
- Disable run halt or reset cumulative spend (#129, both tiers).
- Settle an attempt twice or drop retained unknown exposure.
- Reintroduce the hidden `+256` cap; omit system/schema/repair input from quote.
- Clear timeout at headers, ignore body limit, or permit dispatch after run expiry.
- Omit processor identity from content-version/cache provenance.
- Pass raw chart input or an upstream body into payloads/logs/public errors.
- Restore implicit generation to the chart-saving route or generation on status GET.

### Planned commands and evidence discipline

Scoped examples (include the eventual new filenames as implemented):

```bash
npx tsx --test tests/readings-adapter.test.ts tests/readings-pipeline.test.ts tests/readings-corpus.test.ts
RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/readings-db.test.ts tests/account-lifecycle-lock.test.ts
npm run db:manifest:check
npm run db:check
```

New DB tests must be run with a real disposable database and integration flags,
not reported green because they skipped. Fakes are appropriate for HTTP and time,
not for proving PostgreSQL contention, FKs, or uniqueness.

The operator explicitly authorized the cross-cutting local/synthetic verification pass and fixes/reruns of these exact commands per `CODE_REVIEW.md` §6:

```bash
npx next typegen
npm run typecheck
npm run lint
RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts
npm run build
```

Run local migration/upgrade/manifest verification before that pass. Check compiled
route packaging and an authenticated built-server smoke with a local fake HTTP
provider, not merely an imported adapter unit test. Capture DB cleanup and restored
mutation state. The author then performs the repository's own pre-PR self-review;
external review is not a substitute for that pass.

## 13. Definition of ready and remaining issue scope

Step 1 is implementation-complete only when S1–S12 are proved with the matrices
above, migrations/readiness agree, en/es consent and withdrawal work, ordinary
charts remain unchanged, and the final diff/evidence reflect the actual head SHA.
No full-suite result from another PR or fixture success is live-provider evidence.

Potential closing claims in the future PR are #105, #128, and #129 **only after
their acceptance evidence exists**. #104/#108 are references for the implemented
lifetime-free portion; rendering and paid volume policy remain. Explain any
acceptance-language correction (especially the non-personal-data claim and stale
monthly-free wording) rather than silently treating it as satisfied.

No new human/second-approver enforcement gate is introduced. Follow the existing
COMMENT-review, thread resolution, SHA-pinned evidence, and operator merge process.
No GitHub issue edits, PR creation, push, merge, or hosted deployment is authorized
by this planning document itself.

At the planning handoff, verification performed: read the live scoped issues and existing policy,
traced the source at the pinned base, checked the remote staging SHA, inspected
migration/readiness/packaging and deletion callers, and listed open PRs to identify
potential overlap. Refresh file-level overlap before implementation; the listing
alone is not a completed overlap review.
At that handoff no dependencies were installed and no behavior tests/mutations/build were run. Implementation evidence is recorded separately; hosted environments, secrets and real providers remain untouched.

## 14. Final activation stage — secrets last

Everything through implementation, local verification, mutation evidence, review,
and a later authorized generation-off rollout can be prepared without new external
credentials. Existing hosted credentials remain in their secret managers; they
are not copied to this workspace or chat.

Only after those gates, and explicit approval to begin execution-order step 2:

1. Choose/verify the non-secret processor profile, endpoint, model IDs/aliases,
   token accounting contract, MXN prices, timeout budget, and public en/es consent
   disclosure. Validate the exact structured-output schema against that provider;
   “OpenAI-compatible” alone is not proof of compatibility. No generic unnamed
   processor or fixture price defaults for live work.
2. **Then** add the LLM API key directly to the approved environment's secure
   secret manager. Never paste it into chat, a command transcript, a document, or
   Git. Do not request Stripe/mail/production credentials for this slice.
3. Start with an isolated synthetic-account/fixture-chart live check, one approved
   free run per account/locale; record actual response model, measured/unknown
   spend, latency, and output privately as appropriate. Do not use real birth
   data to test a consent boundary.
4. Keep public generation off until its user-facing output is honestly available
   through the subsequent #104/#106 work and the real-provider check passes.
   Production enablement/promotion remains a separate explicit decision.


## 15. Implementation handoff

- [Executed evidence and author self-review](reading-generation-safety-verification.md)
- [Generation-off rollout, legacy classification, recovery and activation limits](setup/09-reading-generation-safety.md)

The operator subsequently authorized committing and pushing this implementation
on the existing session branch. PR creation, hosted migration, deployment, issue
closure and provider credential setup still require separate authorization.
