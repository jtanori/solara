# Paid reading editions, worker and editorial evaluation

**Implementation/runbook, not authorization to activate or deploy.** Both generation
flags and the database control default off. No genuine provider evaluation or
editorial approval is supplied by test fixtures. The approved product contract is
[paid reading editions](../plan-paid-reading-editions.md); free recovery remains in
[reading generation safety](09-reading-generation-safety.md).

## Customer contract

1. Save a chart without AI work or allowance use. A paid-first customer need not
   use the lifetime-free offer. Select the intended saved chart, language and
   edition scope before checkout; the chart context survives sign-in/checkout.
2. A success return from checkout is **not entitlement**. The dashboard waits for
   verified subscription synchronization. Active/trialing, `grants_access=true`
   and a future period end are required. Webhooks do not dispatch interpretations.
3. Explicitly accept the named-processor disclosure (if the current receipt does
   not cover it) and confirm use of this month's allowance. `POST /api/readings/
   <id>/paid` accepts a durable intent, not a promise running in an HTTP request.
4. The worker calculates authorized Placidus facts, persists its snapshot and
   generates each section. The customer can close the browser and return to
   queued/preparing/generating/completed/partial/stopped/attention status. Polling
   stops after 60 seconds/20 GETs; checking again does not submit again.
5. Open a specific edition through `?paidEdition=<uuid>` on either the page or
   PDF URL. Prose, locale, facts and expected-section manifest remain frozen.
   Subscription expiry does not remove saved editions. A translation or refresh
   is a new funded request; interface-language changes never generate.

The allowance is **one per verified account per UTC calendar month**, without
rollover or subscription stacking. Acceptance reserves it; the first committed
provider permit consumes it, including failed and positively unsent calls. A
fenced wholly pre-permit failure/stop releases it. Release is not a Stripe refund.
A lost POST response is followed by GET, not an automatic retry. The server also
idempotently returns an existing intent. Unknown spend blocks later paid work,
including later months and chart deletion. There is no ad-hoc credited retry.

## Frozen profiles and facts

| Profile | Sections | Snapshot / calculation policy |
| --- | --- | --- |
| `paid-core-v1` (default) | overview, sun, moon, ascendant, aspects, houses, planets, nodes, guidance | `paid-snapshot/1`, `placidus-return-v1` |
| `paid-rich-v1` | the core list with planetaryYear and transits inserted before guidance | `paid-snapshot/2`, `placidus-return-annual-v1` |

Overview and Sun are regenerated using paid prompts and Placidus facts; existing
free whole-sign prose and `readings.result` are never overwritten. Unsupported
return Placidus stops before a provider permit; no whole-sign fallback is sold
as Placidus. Old nine-section editions never become eleven-section reports.

The rich profile adds `annual-facts-v1`: natal angles at the resolved birth
instant (including the selected DST-fold occurrence), age attained in the selected
return year (`returnYear - birthYear`), traditional whole-sign profections and
traditional rulers. These natal whole-sign houses are not return Placidus houses.
A missing natal Ascendant is an explicit unavailable profection, never replaced
with the return Ascendant. Ten moving bodies are compared with fixed natal
bodies/available angles at **the frozen solar-return instant**, not worker time.

Transit policy: conjunction/opposition/trine/square 3°, sextile 2°, no luminary
bonus; exact <=0.001° takes precedence; otherwise stationary at |speed|<0.003°/day
or orb-slope magnitude <1e-7, else applying/separating from central ±6-hour samples
moving only the transit body. Ordering is Pluto → Neptune → Uranus → Saturn →
Jupiter → Mars → Venus → Mercury → Sun → Moon, then orb, then natal point. Up to
120 aspects are stored; the digest/display share the first 24 and total count.
This is an instant snapshot, **not an annual calendar, future date or pass count**.
Chiron, asteroids and Lilith are not included.

Rich processing uses disclosure policy `derived-chart-annual-v2` and requires
fresh consent after the narrower `derived-chart-v1`. The provider receives derived
natal facts, age, profection and transits, not raw birth/return timestamps, names,
email, places or coordinates. Derived data is not guaranteed anonymous. HTML/PDF
may show the owner's frozen return reference; that is not the provider payload.

## Execution, money and stop semantics

- Dedicated supervised Node 22 process, shared database queue; no public worker
  endpoint, request `after()`, untracked promise or GET-triggered execution.
- Active deadline 10 minutes; queued reservation 15 minutes; lease 30 seconds;
  heartbeat 5 seconds. A configured worker must advertise within 20 seconds for
  new acceptance. Runtime/host support is a release gate, not implied by this CLI.
- The entire input billing cap plus 2,000 output tokens is reserved before each
  primary/repair. At most 18 core or 22 rich calls. All worst-case calls must fit
  the **10,000,000 micro-MXN (10 MXN) provider-exposure ceiling**, not a retail price.
  Cheap and strong models, every served alias, prices and input caps are checked.
- Every permit rechecks ownership, consent receipt/revision, entitlement, exact
  configuration/content version, editorial approval, shared revision and lease.
  Provider HTTP runs outside database transactions. Stripe subscription writes
  share the user fence, after their subscription advisory lock; workers never
  acquire that advisory lock.
- Receipt and validated checkpoint commit together. Invalid raw output is neither
  stored in the financial ledger nor sent to the repair prompt. Only settled
  checkpoints can resume; reserved/unknown attempts are never replayed.
- Explicit stop fences new dispatch and heartbeat aborts in-flight transport.
  Already authorized exposure remains. Withdrawal/deletion prevents publication;
  account deletion cascades paid rows, chart deletion retains consumed accounting.
  Entitlement expiry forbids new calls but permits publication of already recorded
  authorized sections under unchanged consent/ownership/publication fences.
- Terminal finalization deletes temporary snapshots/checkpoint prose; immutable
  editions retain the validated frozen display snapshot. Published editions use
  insert-only identities, not `ON CONFLICT` replacements of free documents.

## Configuration and supervisor contract

All three env templates include:

- `READINGS_GENERATION_ENABLED` — global switch, off by default.
- `READINGS_PAID_GENERATION_ENABLED` — paid switch, off by default.
- `READINGS_PAID_EXECUTOR=database-worker-v1` — set only for a bound/qualified worker.
- `READINGS_PAID_PROFILE=paid-core-v1|paid-rich-v1` — exact profile; unknown disables paid.
- The existing `READINGS_PROVIDER`, endpoint/key, named `READINGS_PROCESSOR_PROFILE`,
  cheap/strong model IDs, prices and per-attempt timeout from the free runbook.
  Bad strong/profile configuration cannot turn an otherwise valid free setup into
  a paid-capable one; free authorization remains a separate path.

Worker commands (operator-controlled environment; **not instructions to activate now**):

```bash
npm run readings:worker -- --once     # bounded maintenance + at most one job
npm run readings:worker -- --loop     # supervisor-managed, 2-second idle cadence
npm run readings:worker -- --disable  # shared control off, always bumps revision
# Only after all release gates and explicit activation permission:
npm run readings:worker -- --enable
```

`--enable` refuses missing flags/config; it does not create editorial approvals.
Every control change increments the shared revision, so disable/re-enable cannot
resurrect old dispatch authority. Maintenance still reaps expired jobs while the
worker's generation flags are off. A `--once` infrastructure failure exits nonzero;
loop mode emits sanitized warnings and keeps running. SIGTERM/SIGINT stops taking
new work after the active bounded job; the supervisor must allow draining or
expect the next worker to handle the expired lease conservatively. Never call an
abrupt process termination a zero-cost cancellation.

Package the worker with the reviewed sources/prompts, Node 22, the lockfile and
`tsx` (currently a dev dependency; a dedicated worker image must install it).
A Vercel web deployment alone does **not** run this loop. Do not point a scheduler
at a public Next endpoint or set the executor variable to simulate a deployed
supervisor. Qualify restart/drain, overlapping workers, secrets, DB pool totals,
monitoring and exact configuration parity separately before activation.

Read-only aggregate diagnostics, with **no prose/birth input**:

```sql
SELECT status, profile, count(*) FROM paid_reading_runs GROUP BY status, profile;
SELECT state, count(*), sum(reserved_micros) AS reserved_micro_mxn,
       sum(cost_micros) AS settled_micro_mxn
FROM paid_reading_attempts GROUP BY state;
SELECT enabled, revision,
       worker_heartbeat_at > clock_timestamp() - interval '20 seconds' AS worker_recent
FROM paid_reading_control WHERE id = 'paid';
```

Separate measured cost from reserved/unknown exposure. Do not delete attempts,
clear `consumed_at`, raise ceilings, or overwrite editions to make a retry work.

## Versioned bilingual evaluation (#109)

`tests/fixtures/readings/paid-corpus-v1.json` freezes six synthetic cases and the
English/Spanish full-report rubric. Inputs reference the independent annual
calculation fixture: baseline, DST-fold earlier/later, southern hemisphere,
leap-day, and unavailable polar natal angles. Numerical fixtures are not prose
quality approval and are not professional certification.

Offline commands need no database, network, flags or credentials:

```bash
npm run readings:evaluate -- --synthetic --profile paid-core-v1
npm run readings:evaluate -- --synthetic --profile paid-rich-v1
# For separately authorized provider-evaluation evidence, not an automatic call:
npm run readings:evaluate -- --report /private/report.json --output /private/review
npm run readings:evaluate -- --report /private/next.json --compare /private/prior.json --output /private/comparison
```

Default synthetic output is ignored `.venv/paid-evaluation/<profile>/`: `report.json`,
`metrics.json`, `review-packet.md`, and **blank** en/es review templates. Report
files are bounded and contain derived facts, typed sections and attempt receipts,
not raw provider bodies or raw birth inputs. The tool never calls a live provider.
Actual provider evidence must come from a separately authorized, bounded pilot;
there is deliberately no back door around account consent/funding or the public
editorial gate. No genuine pilot or sign-off is included in this implementation.

Compare schema/prompt/model/configuration hashes, frozen-fact changes and per-section
before/after prose. Review semantic changes against the rubric, not a model's
self-score. Metrics separate measured/uncertain exposure, repairs, failed attempts,
incomplete reports and attempt p95/summed-attempt latency. Synthetic elapsed times
and token estimates are engineering data, **not live cost/latency qualification**.

The operator/editor reviews **all six complete reports in the selected locale**
against the included facts. Score each criterion 0/1/2; only all-2 passes qualify:
specificity, factual agreement, cross-section consistency, language, completeness,
no paid upsell, honest limitations. Notes, reviewer and evidence reference are
mandatory. Copy the explicit full-report attestation only after performing that
review. There is no independent-person/GitHub-identity requirement.

Validation defaults to check-only:

```bash
npm run readings:approve-evaluation -- --report /private/report.json --review /private/review-en.json
# Explicit privileged mutation only after authentic editorial review:
npm run readings:approve-evaluation -- --report /private/report.json --review /private/review-en.json --record
```

Repeat for Spanish. Approval pins profile/contentVersion/locale/config, corpus,
facts, prompt/schema hashes and report/sample hashes. It validates model tier,
served aliases, exact quote/usage/price arithmetic, completeness and exposure.
Synthetic-labelled/fixture-model reports and unfilled templates cannot approve.
The database insert does not overwrite/revive an old approval and never enables
controls. Store the report/review in private durable evidence storage and include
its reference; the DB records the report hash. A changed relevant configuration or
content version requires fresh evidence. Operators remain responsible for honest
provenance: a self-authored JSON label is not cryptographic proof of a provider
invoice. Do not relabel fixtures as provider reports or sign reviews not performed.

## Local regression and mutation checks

With a disposable loopback database, no hosted secrets, and both generation flags
off, run the full repository gates plus the paid suites. The authenticated
production-mode `scripts/verify-reading-browser.ts` checks both profiles, both
locales and complete/partial pinned page/PDF editions, with outbound fetch denied.
Its ledger comparison covers free **and paid** state. These are synthetic
engineering checks, not a real Stripe lifecycle or provider/editorial evaluation.

From a committed clean checkpoint only, `node scripts/verify-reading-mutations.mjs
--group=paid` deliberately removes selected paid/annual/editorial/checkout guards,
requires assertion failures (not syntax/import/timeouts), restores sources after
every case, then reruns the scoped suite, production build and real-app browser
checks. `--only=<name>` narrows a case; the default group remains the original
presentation guards. Artifacts/backups remain ignored under `.venv/reading-mutations/`.
Follow mutations with the full restored-tree validation before claiming readiness.

## Migration and release boundary

- `0007_paid_reading_editions` adds eight tables, disabled shared control and
  immutable snapshot/edition update triggers. It neither adopts legacy paid rows
  nor changes free history or `0006`.
- `0008_paid_annual_facts` widens four checks for the rich manifest/annual sections;
  no existing editions or prose are rewritten. Full local journal has nine rows.
- Runtime manifest requires 24 tables, 147 columns and 22 indexes. Rehearse from
  an empty DB and an upgraded representative DB; independently inspect constraints,
  cascades, unique slots and triggers, not just migration exit status.
- Keep flags/shared control off on every deployment, pin SHA, back up, rehearse
  exact-SHA staging migrations with `db-remote`, then follow the existing deploy
  procedure. Old code cannot safely roll back past a journal it does not recognize;
  disable and forward-fix or use a rehearsed restore. Never rewrite applied SQL.
- Before purchase acceptance: separate checkout pagination #143, real Stripe test
  lifecycle #10, genuine model/privacy/editorial evidence, hosted PDF/resource
  qualification, supervisor binding and generation-off browser/readiness QA.
  Email testing is deferred. Production promotion and provider activation require
  explicit separate authorization. Local green tests do not waive these gates.
