# Paid editions — local implementation verification

## Evidence boundary

Code/test revision: **`7d5549c6d918d18b0e8703dee0d198e1218512cd`** on
`arena/d350cb2e-solara`, based on staging
`e79671a6658b82a1867afdb30cbcaae4b6481bed`.
This evidence note is added after that run; it is not a claim about later code changes.

The approved implementation covers the separate paid core/rich editions, durable
accounting and worker, explicit customer journey, annual facts, pinned page/PDF
and #109 evaluation/approval tooling. It **does not activate generation**. No
hosted migration, deployment, real Stripe purchase, real-provider call or genuine
editorial approval was performed. Synthetic provider-labelled protocol tests are
not provider evidence. Email testing remains deferred.

Environment: Node **22.22.3**, npm **10.9.8**, PostgreSQL **16.2** on disposable
loopback port 5438, Chromium **153.0.8010.0**. Dotenv loading was disabled. Integration
tests deliberately exercise enabled states with fake transport and synthetic
accounts only, then clean up. After validation, SQL assertions confirmed the
shared paid control was **disabled** and the approval table contained **0 rows**.

## Final results

| Check | Observed result |
| --- | --- |
| `npx next typegen` | pass |
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| Whole disposable-DB suite, both integration flags | **707 passed / 0 failed / 0 skipped**, 415787.538871 ms |
| `npm run build` | pass, production build and TypeScript |
| `npm run db:manifest:check` | manifest current |
| `npm run db:check` | required **24 tables / 147 columns / 22 indexes** present; no pending/unexpected migrations |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** (the repository CI audit scope) |
| Paid mutation group | **26/26 assertion kills**, all sources restored; **64/64** restored scoped tests, build and production-mode browser checks pass |
| Presentation mutation group | **59/59 assertion kills**, all sources restored; **154/154** restored scoped tests, build and production-mode browser checks pass |
| Production-mode authenticated browser QA | **22 cases**, **0 provider fetches / 0 automatic POST/PUT**, free and paid ledgers unchanged by reads |
| `node scripts/check-pdf-package.mjs` | **218 files / 5.9 MiB**; worker/fonts/metrics/license present; no test/browser/extractor files |
| Disabled `npm run readings:worker -- --once` | exit 0 |
| Worker `--enable` with flags off; unknown command | each refused, exit 1 |
| Synthetic core/rich offline evaluation | 12 full synthetic reports/profile; explicitly **NOT APPROVED** |
| Synthetic report + blank review with approval CLI `--record` | refused, exit 1; no approval created or control enabled |
| `git diff --check` | pass; generated `next-env.d.ts` development/build path churn restored, not committed |

**Historical audit caveat at the feature-only revision:** the additional
unrestricted `npm audit --json` was **not clean**: 19 findings (9 high, 10 moderate)
in development tooling (ESLint/glob dependencies and Drizzle Kit's nested esbuild).
No dependency declarations or lockfile changed in that feature revision. The
zero-vulnerability row above is production-only; every affected path was separately
checked as `dev: true`. Those historical results are not rewritten or treated as
a waiver. The later, separately committed remediation and both clean audits are
recorded in [dependency-remediation.md](dependency-remediation.md); no audit
command, CI threshold or workflow was weakened.

**Original PR handoff hold — now resolved by dependency cleanup:** under
`docs/PR_WORKFLOW.md` §1.10, publication at `f4a5c8c` did not file a PR because its
unrestricted audit was not clean. The operator subsequently authorized fixing
all findings. The cleanup now has clean unrestricted/production audits, a refreshed
staging check and full validation. Only that audit-related hold is lifted; normal
PR review/CI and release gates remain. No waiver, separate reviewer identity,
merge/deployment authority or generation activation is inferred.

The final whole-suite run happened **after** both successful mutation groups and
their restoration. Earlier failed harness targets and obsolete catalog snapshots
are not counted as final evidence. A function-bearing assertion was changed to a
primitive comparison to preserve Node's assertion metadata; the mutation runner
still refuses syntax/import/timeout failures. Removing only one of two redundant
free-membership checks was an equivalent mutant, so the final mutation removes
both checks. No production guard was weakened to make a test pass.

## Commands and authorization

The operator's standing `full-validation=authorize` covered local checks,
fixes/reruns and fake-provider/disposable-data integration. Expensive commands and
their purposes were announced. The final sequence used this environment:

```bash
export DOTENV_CONFIG_PATH=/dev/null
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5438/paid_readings
export APP_URL=http://localhost:3000
export NEXT_TELEMETRY_DISABLED=1
export READINGS_GENERATION_ENABLED=false
export READINGS_PAID_GENERATION_ENABLED=false

# Each runner requires a clean committed checkpoint and restores all mutations.
node scripts/verify-reading-mutations.mjs --group=paid
node scripts/verify-reading-mutations.mjs --group=presentation
npx next typegen
npm run typecheck
npm run lint
RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts
npm run build
npm run db:manifest:check
npm run db:check
npm audit --omit=dev --audit-level=high
npm run readings:worker -- --once
node scripts/check-pdf-package.mjs
```

`npm ci` and the guarded local migrations were run earlier in the implementation;
no dependency or lockfile change followed. The migration integration case also
creates an independent database, installs 0000–0005, seeds historical edge cases,
upgrades through 0008 and repeats the migrator. It independently inspects paid
seed data, immutable triggers, manifests, deletion FKs and unique/partial indexes.
The final full suite includes that test. A structural comparison of generated
snapshots confirmed all 16 original table definitions unchanged by 0007, eight
paid tables added, and only the four intended checks changed by 0008. Migrations
0000–0006 and their metadata were not rewritten.

Logs, PDF rasters and synthetic evaluation packets were kept in ignored `.venv/`
folders, not shipped or committed. The commands, results and mutation table here
are the durable record; access to the original workspace is not required to read
this report. Rerunning requires a separately provisioned disposable local DB and
normal repository dependencies, never hosted secrets or customer data.

## What the tests establish

- Paid-first acceptance reserves one account/UTC-month allowance without using
  free generation. Replay returns the same intent; concurrent paid requests cannot
  reserve multiple monthly allowances. The first committed permit consumes the
  allowance even when the settled charge is zero; only a fenced pre-permit
  terminal path releases it.
- Real handlers, durable transactions and the real transport adapter with fake
  HTTP cover ownership/verified identity, current active/trialing entitlement,
  future period end, consent receipt/revision, shared control revision, exact
  config/content version, approval, deadline and lease-owner fences. The webhook
  and permits share a user fence; no database connection spans provider HTTP.
- Crash recovery reuses settled valid checkpoints and sends only missing
  sections. Reserved/unknown exposure is never replayed and remains blocking
  after month rollover or chart deletion. Actual over-ceiling cost is not clamped.
  Primary/repair receipts and private validated outcomes settle together.
- Stop, withdrawal, chart/account deletion and entitlement expiry have distinct
  effects. Late receipts cannot authorize publication or recreate erased data.
  Expiry can finalize already authorized recorded sections, but cannot authorize
  another primary or repair.
- Core nine-section and rich eleven-section manifests remain separate. Published
  editions are immutable; unsupported return Placidus stops before a permit.
  Old free prose, its lifetime accounting and canonical selection remain intact.
  An unproven legacy paid row is not an authorized edition.
- Paid pages/PDFs use the same saved snapshot and locale, never today's free
  calculation or a latest-row substitution. Both profiles × EN/ES × complete and
  partial editions were exercised through authenticated production page/RSC/PDF
  reads, mobile 390px layout, 200% reflow, locale navigation, ownership and sign-in
  returns. The selected owned chart survives pricing and an unverified checkout
  return; those paths never generate.
- Six independent development-only Swiss Ephemeris/Moshier reference cases plus
  hand calculations exercise natal angles, selected-year age, traditional rulers,
  birth DST-fold choice, return-instant transit order/orbs/phase and polar natal
  limitations. No runtime ephemeris dependency was added. This is engineering
  evidence, not professional astronomical/editorial certification.
- The editorial interface requires six full reviewed reports per locale and exact
  profile/config/content/corpus/fact/prompt/schema/sample binding. Re-signed forged
  costs, model tiers, served aliases, reservation quotes and usage bounds are
  rejected. It cannot turn synthetic reports or blank templates into approval.
  Hashes and provenance labels are not cryptographic proof of a provider invoice;
  honest full-report review remains required.

## Catalog/PDF review

Author self-review caught stale claims on general pricing, topic previews and the
Premium guide. Generic pricing now distinguishes disabled rollout from an enabled
flag without a verified chart-specific offer. Only the latter verified offer may
advertise the allowance. Static previews defer to saved-chart availability and
never promise automatic generation or a year-long transit calendar.

The intentional catalog change updated six free/partial fixed-DPI PDF baselines.
All eight fixtures remain four pages. An explicit text-delta allowlist confirmed
only the current-catalog notice, annual teaser/title and availability labels
changed. For each free/partial fixture the first two chart/prose page hashes are
identical; both historical paid renderings are entirely identical. The EN/ES
catalog page 3/4 rasters were visually inspected for wrapping, order, accents and
clipping. The restored 80-test PDF/presentation baseline passed before the final
mutation and whole-suite runs. No assertion threshold was lowered.

## Author review, scope and release gates

This is **AI-assisted author self-review**, not independent verification or merge
permission. The review traced acceptance → queue → claim → calculation → permit →
transport → settlement → publication → pinned read/download and the negative paths
listed above. Full changed sources, tests and documentation were reviewed;
generated schema metadata received the structural comparison described above.
The two profile migrations, frozen edition/provenance model, shared authorization
helpers, free-path preservation and deployment trace were reviewed together.

The patch is larger than the usual 400-line preference because the approved
sequence is one generation-off end-to-end product increment: accounting without
its worker/publication/ownership boundaries would not be a usable vertical slice.
Over 5,000 lines are generated Drizzle snapshots; additional bulk is the independent
numerical fixture and guard/integration tests. There is no unrelated workflow or
dependency upgrade. The only shared-helper extractions support both execution paths.

Freshness was rechecked after validation: remote staging and merge base still
`e79671a6658b82a1867afdb30cbcaae4b6481bed`. Open auth PR #140 has no file overlap.
Dependency PRs #26–#35 overlap `package.json`; this feature only adds three scripts,
not dependency versions or the lockfile. Proposed order is this product increment
then dependency updates, with normal merge/freshness/full-gate checks if the base
moves. No other branch was modified.

**Still unverified / not authorized by this work:**

- Genuine provider cost/latency/privacy evaluation and full EN/ES editorial sign-off.
- Hosted worker binding, supervision/restarts/drain and web/worker config parity.
- Real Stripe test lifecycle (#10) and separate checkout pagination fix (#143)
  before purchase acceptance. A synthetic webhook fence is not a real purchase.
- Exact-SHA hosted migration rehearsal/application, current hosted page/PDF resource
  qualification and generation-off readiness/browser QA.
- Activation, production promotion, email delivery testing, merge or deployment.

Keep global/paid flags and shared control off. The migrations must go through the
existing rehearsal/deployment procedure before compatible code is released.
Rollback is disablement plus compatible forward fix or rehearsed restore, not
blindly promoting an older binary that cannot recognize the new journal.

## Mutation evidence

Every row below records an assertion failure on a deliberately broken source,
not an expected-output rewrite. Both complete groups ran at the code/test revision
above, restored the originals, and passed their scoped tests, build and production
browser rerun. The later full suite was also green.

The mutation IDs and exact replacement definitions are in
`scripts/verify-reading-mutations.mjs` at the reviewed revision. Run a single row
with `node scripts/verify-reading-mutations.mjs --group=<group> --only=<id>`
from a clean checkpoint. Each row names an observed assertion; some mutants also
triggered additional assertions in the same scoped suite.

### paid (26/26)

| Mutation ID | Scoped test / observed assertion | Result |
| --- | --- | --- |
| `paid-owner-scope` | `tests/paid-readings.test.ts`: foreign and legacy paid rows are not authorized editions; free canonical document remains identical | Assertion kill |
| `paid-entitlement-each-call` | `tests/paid-readings.test.ts`: entitlement is checked before paid calculation and each dispatch; expiry can finalize recorded sections | Assertion kill |
| `paid-consent-each-repair` | `tests/paid-readings.test.ts`: a settled invalid checkpoint does not bypass fresh consent, entitlement, stop or lease checks for repair | Assertion kill |
| `paid-shared-revision` | `tests/paid-readings.test.ts`: repair itself requires current consent and shared revision; kill and re-enable cannot revive an old grant | Assertion kill |
| `paid-owner-fence` | `tests/paid-readings.test.ts`: settled checkpoint survives crash; replacement worker sends only missing sections and fences stale owner | Assertion kill |
| `paid-lease-deadline` | `tests/paid-readings.test.ts`: a settled invalid checkpoint does not bypass fresh consent, entitlement, stop or lease checks for repair | Assertion kill |
| `paid-rich-repair-budget` | `tests/paid-readings.test.ts`: rich paid worst-case preflight includes two extra primaries and repairs, while core and free configuration remain valid | Assertion kill |
| `paid-warm-content-version` | `tests/paid-readings.test.ts`: content-version changes fence a warm worker before repair even when model/pricing fingerprint stays unchanged | Assertion kill |
| `paid-uncertain-replay` | `tests/paid-readings.test.ts`: a committed uncertain slot is never replayed, even after lease expiry, chart deletion or a new period | Assertion kill |
| `paid-actual-spend-not-clamped` | `tests/paid-readings.test.ts`: measured error spend produces an honest partial edition; actual over-ceiling usage is not clamped | Assertion kill |
| `paid-atomic-checkpoint` | `tests/paid-readings.test.ts`: settled checkpoint survives crash; replacement worker sends only missing sections and fences stale owner | Assertion kill |
| `paid-zero-cost-consumed-allowance` | `tests/paid-readings.test.ts`: ledger validates model receipts, enforces one outstanding attempt and never releases a consumed zero-cost permit | Assertion kill |
| `paid-snapshot-hash` | `tests/paid-readings.test.ts`: paid read rejects an otherwise valid frozen snapshot with a mismatching hash and unpublished or mismatched run provenance | Assertion kill |
| `paid-snapshot-facts` | `tests/paid-readings.test.ts`: stored edition display never reuses a changed chart; snapshot contradictions are rejected | Assertion kill |
| `paid-manifest-completeness` | `tests/paid-readings.test.ts`: paid completeness is the frozen nine-section manifest, never just overview/Sun | Assertion kill |
| `paid-get-never-reaps` | `tests/paid-readings.test.ts`: queued deadline and month rollover release only pre-permit reservations; GET never performs recovery | Assertion kill |
| `annual-selected-year-age` | `tests/annual-facts.test.ts`: annual facts: hand-checked whole-sign wheel, age zero/12/42 and all traditional rulers | Assertion kill |
| `annual-traditional-scorpio-ruler` | `tests/annual-facts.test.ts`: annual facts: hand-checked whole-sign wheel, age zero/12/42 and all traditional rulers | Assertion kill |
| `annual-transit-motion` | `tests/annual-facts.test.ts`: annual facts: hand-checked applying/separating, zodiac wrap, fixed natal, exact and stationary conventions | Assertion kill |
| `annual-birth-not-return-place` | `tests/annual-facts.test.ts`: annual facts: independent natal angles, return instant and transit reference — baseline | Assertion kill |
| `annual-consent-payload-version` | `tests/annual-facts.test.ts`: annual facts: richer derived age/natal/transit fields require a different explicit consent policy | Assertion kill |
| `editorial-reject-synthetic` | `tests/paid-evaluation.test.ts`: paid corpus: paid-core-v1, six frozen charts × two locales, full typed sections and cost/latency receipts without live transport | Assertion kill |
| `editorial-exact-version` | `tests/paid-evaluation.test.ts`: editorial approval protocol: exact-profile/config/locale/corpus/sample binding, six full reports, no independent identity requirement | Assertion kill |
| `editorial-receipt-arithmetic` | `tests/paid-evaluation.test.ts`: editorial receipts: validate exact per-section model, aliases, usage, quote and price arithmetic rather than trusting a signed cost | Assertion kill |
| `checkout-final-chart-fence` | `tests/checkout-context.test.ts`: checkout context: chart disappearing before the lease or at the final URL fence is not returned as a payable success | Assertion kill |
| `paid-streamed-body-limit` | `tests/control-json.test.ts`: control JSON: split UTF-8, exact byte limit and no content-length header are supported | Assertion kill |

### presentation (59/59)

| Mutation ID | Scoped test / observed assertion | Result |
| --- | --- | --- |
| `owner-scope` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: reader: unauthenticated, unverified, malformed and cross-owner reads are rejected | Assertion kill |
| `pinned-identity` | `tests/readings-page.test.ts`: PDF HTTP: authenticated selectors and tenancy fail closed with private headers | Assertion kill |
| `run-locale` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: reader: mismatched run version/locale/status and stored identity do not select alternate content | Assertion kill |
| `run-version` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: reader: mismatched run version/locale/status and stored identity do not select alternate content | Assertion kill |
| `published-state` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: reader: mismatched run version/locale/status and stored identity do not select alternate content | Assertion kill |
| `sql-byte-bound` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: reader: oversized JSON is not transferred from SQL to Node | Assertion kill |
| `reader-network-dispatch` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: reader: exact canonical locale/version wins over newer rows, UI locale and subscription | Assertion kill |
| `free-paid-key` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: presentation: free tier rejects paid keys, forged section tiers, duplicate/unknown keys, and malformed headers | Assertion kill |
| `duplicate-section` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: presentation: free tier rejects paid keys, forged section tiers, duplicate/unknown keys, and malformed headers | Assertion kill |
| `row-envelope-identity` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: presentation: every row/envelope identity dimension must agree, even for otherwise valid JSON | Assertion kill |
| `closing-question` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: presentation en: frozen free content, all blocks, questions, ordering and nine static previews | Assertion kill |
| `unknown-payload` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: presentation: unknown block is absent, supported siblings and questions survive; all-unknown is not empty success | Assertion kill |
| `raw-metadata` | `tests/readings-page.test.ts`: PDF HTTP: canonical saved locale/version, frozen text and pinned filenames ignore UI/plan/notes | Assertion kill |
| `decoder-byte-bound` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: presentation: byte and aggregate text bounds are independent of per-field bounds | Assertion kill |
| `aggregate-text-bound` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: presentation: byte and aggregate text bounds are independent of per-field bounds | Assertion kill |
| `planned-preview` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: presentation en: frozen free content, all blocks, questions, ordering and nine static previews | Assertion kill |
| `expired-status` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: generation view extraction: preserves original status/expiry/tombstone semantics | Assertion kill |
| `ui-locale-overrides-saved` | `tests/readings-page.test.ts`: PDF HTTP: canonical saved locale/version, frozen text and pinned filenames ignore UI/plan/notes | Assertion kill |
| `newest-row-substitution` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: reader: exact canonical locale/version wins over newer rows, UI locale and subscription | Assertion kill |
| `paid-provider-dispatch` | `tests/readings-pipeline.test.ts`: document: free tier shape, ordering, models, cost accounting, locked sections | Assertion kill |
| `subscription-selects-paid` | `tests/readings-presentation.test.ts, tests/readings-view.test.ts`: reader: paid or malformed free rows are unavailable even to a paid account | Assertion kill |
| `pdf-link-unpinned` | `tests/readings-renderer.test.ts`: page: PDF identity stays pinned across UI locale/plan, explicit chart edition remains separate | Assertion kill |
| `explicit-chart-controls` | `tests/readings-renderer.test.ts`: page: explicit chart edition omits AI controls and keeps canonical navigation in en | Assertion kill |
| `permanent-pdf-retry-after` | `tests/readings-page.test.ts`: PDF HTTP: safe render/DB errors, private headers and no raw error logs | Assertion kill |
| `legacy-question-partial` | `tests/readings-presentation.test.ts`: presentation en: legacy-only notices preserve completeness but degraded sections remain partial | Assertion kill |
| `pdf-question-dropped` | `tests/pdf.test.ts`: PDF: frozen free-en, semantic order, glyphs, metadata and fixed-DPI layout | Assertion kill |
| `pdf-sections-reversed` | `tests/pdf.test.ts`: PDF: frozen free-en, semantic order, glyphs, metadata and fixed-DPI layout | Assertion kill |
| `pdf-rows-reversed` | `tests/pdf.test.ts`: PDF: long prose, list/keyValue values and a 100-row table split safely with repeated headers | Assertion kill |
| `pdf-orb-dropped` | `tests/pdf.test.ts`: PDF: frozen free-en, semantic order, glyphs, metadata and fixed-DPI layout | Assertion kill |
| `pdf-accent-dropped` | `tests/pdf.test.ts`: PDF: frozen free-es, semantic order, glyphs, metadata and fixed-DPI layout | Assertion kill |
| `pdf-callout-dropped` | `tests/pdf.test.ts`: PDF: frozen free-en, semantic order, glyphs, metadata and fixed-DPI layout | Assertion kill |
| `failed-private-prose` | `tests/readings-renderer.test.ts`: HTML: failed content and internals never render; safe facts and truthful notice do | Assertion kill |
| `raw-error-logs` | `tests/readings-page.test.ts`: PDF HTTP: safe render/DB errors, private headers and no raw error logs | Assertion kill |
| `unknown-drops-sibling` | `tests/pdf.test.ts`: PDF: unknown payload is absent while supported siblings, questions and compatibility notices remain | Assertion kill |
| `polling-post` | `tests/readings-controls.test.ts`: polling: unused/terminal initial GET stops; never PUT/POST/consent | Assertion kill |
| `consent-grant-on-mount` | `tests/readings-browser.test.ts`: browser controls: dashboard en withdrawal has no reading/status dependency | Assertion kill |
| `lost-post-retry` | `tests/readings-browser.test.ts`: browser controls: lost POST response checks partial status without automatic POST/PUT retry | Assertion kill |
| `polling-time-budget` | `tests/readings-controls.test.ts`: polling: 3/6/10 second backoff and a 60 second total budget | Assertion kill |
| `polling-request-budget` | `tests/readings-controls.test.ts`: polling: hard request cap still holds if a clock stops advancing | Assertion kill |
| `refresh-identity-guard` | `tests/readings-controls.test.ts`: refresh: once per published identity for this chart, including unavailable projections | Assertion kill |
| `native-timer-binding` | `tests/readings-browser.test.ts`: browser controls: native Window timers work without fake-clock binding leniency | Assertion kill |
| `private-cache-header` | `tests/readings-page.test.ts`: PDF HTTP: authenticated selectors and tenancy fail closed with private headers | Assertion kill |
| `final-ownership-check` | `tests/readings-page.test.ts`: PDF HTTP: deletion/replacement during render discards the bytes and never recreates content | Assertion kill |
| `parent-input-cap` | `tests/pdf.test.ts`: PDF: unsupported glyphs and oversized input fail closed before success/fork | Assertion kill |
| `parent-output-cap` | `tests/pdf.test.ts`: PDF: output/memory/deadline caps terminate real workers, then the slot is reusable | Assertion kill |
| `concurrency-cap` | `tests/pdf.test.ts`: PDF: abort and concurrent saturation have no queue and no early slot release | Assertion kill |
| `early-slot-release` | `tests/pdf.test.ts`: PDF: abort and concurrent saturation have no queue and no early slot release | Assertion kill |
| `promise-only-cancel` | `tests/pdf.test.ts`: PDF: abort and concurrent saturation have no queue and no early slot release | Assertion kill |
| `external-rss-cap` | `tests/pdf.test.ts`: PDF: parent RSS monitoring interrupts a worker whose own JavaScript never yields | Assertion kill |
| `notes-as-generated-premium` | `tests/pdf.test.ts`: PDF: repeated rendering stays semantically/visually stable, long legacy notes stay illustrative | Assertion kill |
| `mutable-notes-substitution` | `tests/pdf.test.ts`: PDF/HTML: actual canonical reads stay frozen when mutable editorial notes change | Assertion kill |
| `section-heading-orphan` | `tests/pdf.test.ts`: PDF: frozen paid-es, semantic order, glyphs, metadata and fixed-DPI layout | Assertion kill |
| `table-heading-orphan` | `tests/pdf.test.ts`: PDF: leading long tables keep section headings with data; all long cells and Spanish titles survive | Assertion kill |
| `section-heading-overflow` | `tests/pdf.test.ts`: PDF: multiline section titles and subtitles fail safely before unbreakable heading clipping | Assertion kill |
| `table-title-overflow` | `tests/pdf.test.ts`: PDF: oversized repeated table headings fail pre-layout instead of exhausting the deadline | Assertion kill |
| `chart-selector-propagation` | `scripts/verify-reading-browser.ts`: AssertionError: explicit chart edition must not mount AI controls | Assertion kill |
| `premium-plans-promise` | `scripts/verify-reading-browser.ts`: AssertionError: plans do not promise generated paid output | Assertion kill |
| `paid-pricing-flag-not-offer` | `tests/readings-presentation.test.ts`: pricing copy: a flag is not an offer and a missing chart is not proof of global unavailability | Assertion kill |
| `raw-client-rsc-prop` | `scripts/verify-reading-browser.ts`: AssertionError: HTML/RSC leak: fixture-only | Assertion kill |
