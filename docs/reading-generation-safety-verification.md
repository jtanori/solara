# Reading generation safety — local evidence and author self-review

**Scope:** step 1 / #105, lifetime-free portion of #104/#108, #128 and #129.
**Branch/base:** `arena/83b33a0a-solara` / `2c0c64b202fdbf7a9e8f7d91aadc8b950866f14e`.
**State:** implementation remains disabled. This records the **author pre-commit
working-tree self-review**, not independent verification, a posted PR review or an
issue closure. The operator subsequently authorized commit and push only; PR creation,
hosted changes and activation remain outside that authorization. Bind this evidence
to the implementation SHA when a PR is separately authorized.

## Executed validation

The operator explicitly authorized the full local checks and fixes/reruns.
Only disposable loopback PostgreSQL, synthetic accounts/charts and fake provider
transports were used. No hosted data, real provider credentials or live calls.
The final database was newly created as `solara_safety_final`; the earlier rehearsal
database was left untouched when the unpublished migration was refined.

| Exact command/check | Final observed result |
| --- | --- |
| `npm ci --no-audit --no-fund` | 463 packages installed earlier in implementation; no manifest/lockfile/dependency changes. |
| `npm run db:migrate` | Seven migrations on the new empty disposable database; none pending. |
| `npm run db:manifest:check` | Manifest matches the final migration bytes. |
| `npm run db:check` | 16/16 tables, 62/62 required columns, 9/9 required indexes; no pending or unexpected journal hashes. |
| `npx next typegen` | Passed. |
| `npm run typecheck` | Passed, including a rerun after restoring generated-only `next-env.d.ts` churn. |
| `npm run lint` | Passed. |
| `RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts` | **480 passed, 0 failed, 0 cancelled, 0 skipped**, 340029.794391 ms on the final migration/tree. |
| `npm run build` | Passed; all new routes included. |
| Final scoped restoration check (service, migrations, safety regression, transport, pipeline) | 74 passed, 0 failed, 0 skipped after all edits. |
| `git diff --check` plus new-file whitespace/link checks | Passed; 50 changed text files, approximately 500 KB total file contents; no generated dependencies/data included. |
| Generate-route `.nft.json` inspection | **23/23** prompt markdown files traced into the production route. |
| Built-server HTTP smoke, en/es | Passed on final build/database, both with synthetic generation enabled and with generation disabled/unconfigured. |
| Generated migration snapshot comparison | All pre-existing table definitions unchanged; three new tables, 43 new columns, five new indexes and five new FKs. |
| Runbook aggregate-classification SQL | Executed successfully on empty disposable data; all counts zero (not a hosted population measurement). |

The full command environment was:

```sh
export DATABASE_URL=postgresql://solara@127.0.0.1:5438/solara_safety_final
export APP_URL=http://localhost:3000
```

This URL is a disposable local test target, not a deploy target. Build used
`READINGS_GENERATION_ENABLED=false`. HTTP smoke started `next start --hostname
0.0.0.0 --port 3111` with a temporary synthetic-only fetch preload, created real
sessions in local PostgreSQL, and exercised real built routes. It verified:

- Unauthenticated rejection, same-origin enforcement (foreign origin 403),
  private/no-store responses, and healthy `/api/health` + `/api/ready`.
- Chart-only POST; actual authenticated reading HTML and `%PDF-` responses in en/es.
- Named localized consent, explicit grant, two free-section calls per account,
  frozen canonical locale, repeat without new calls, withdrawal, consumed-reading
  deletion and no second free offer on a new chart.
- **Four** intercepted synthetic provider calls across two enabled accounts;
  **zero** with generation off. Complete payloads excluded planted raw input,
  user IDs and fake credentials. Test accounts/sessions/chart data were cleaned up,
  and the temporary HTTP servers were stopped. The preload is not shipped.

This was HTTP/SSR smoke, **not browser hydration, visual or accessibility QA**.
The broad full suite includes existing auth/billing/deletion/lifecycle suites;
it is not evidence of hosted checkout or paid AI generation.

## Boundary evidence

`tests/readings-service.test.ts` has **23 real-PostgreSQL tests**, using real
handlers → service/store → actual chat adapter with fake HTTP. Among their
assertions (not merely names):

- Missing/stale/withdrawn consent, unverified identity, foreign charts and forged
  controls cannot dispatch. Stale grant cannot overwrite withdrawal.
- Two DB connections return one canonical lifetime run. A one-connection app pool
  remains usable while provider HTTP is paused; no application transaction spans it.
- Permit/revision/configuration/deadline checks cover admission, repair and final
  publication. Withdrawal after a committed permit but before send retains the
  consumed offer while settling positively unsent money at zero.
- Consumed allowance survives re-grant, locale changes, failure and reading
  deletion. Expired wholly pre-permit state reuses the same ID/locale. Stale owners
  cannot dispatch; outstanding permits are never replayed. Crash states are
  constructed in PostgreSQL, not tested by killing a hosted worker.
- Account deletion during HTTP cascades new state; late responses cannot recreate
  it. Reading deletion preserves consumed state and permits receipt settlement,
  but prevents further dispatch/publication.
- A real database trigger failure on settlement retains the reservation. A real
  publication INSERT failure retains receipts, produces no document and does not
  replay. Duplicate settlement is idempotent; actual 6,000,000 micro-MXN spend is
  not clamped; later admission is blocked on overrun or unknown exposure.
- Actual rate-limit policies produce 429/Retry-After for generation, consent and
  status, without consuming the allowance. Complete primary/repair payloads and
  serialized transport/DB failures/logs exclude planted private values.
- Chart creation and status GET remain read/compute-only even with active consent
  and a valid live-shaped profile. Shared persistent cache methods are never used.

Transport tests additionally exercise headers-then-stalled-body cancellation,
response size bounds, immutable quote/send bytes, exact output cap, required input
contract, receipt/model validation and endpoint/processor provenance.

The upgrade rehearsal starts at schema `0005`, inserts synthetic legacy data,
applies `0006`, and verifies earliest canonical adoption, fixtures/ambiguous model
exclusion, approved deleted-history cutover, no inferred consent/receipts,
preservation of six surviving documents, idempotence, actual readiness drift and
FK deletion behavior. No actual legacy population was queried.

## Findings corrected during author verification

- Initial full typecheck caught incompatible transaction generics; the helper
  now derives its transaction type from the lifecycle-lock DB contract.
- Initial full suite was 470/471: the consent checkbox lacked name/autocomplete.
  Fixed and rerun; final full result above supersedes it.
- Migration cleanup used forced DROP while pools were shutting down. Ordinary
  DROP removes the idle-client termination race. DB reading tests now isolate and
  clean their cache namespace/users and close both pools.
- A new failing finalization test showed config was evaluated before waiting for
  the final lifecycle fence. It is now a callback evaluated inside publication's
  transaction. The guard-disabling mutant reproduces the original failure.
- New ambiguous-legacy cases showed four adoptions where only one was justified:
  empty model, numeric model and mixed-case fixture IDs. The new unpublished
  migration now excludes them; fresh schema and upgrade tests were rerun. No
  previously hosted/applied migration history was rewritten to disguise drift.

## Fresh mutation evidence

Each row below deliberately changed a guard, ran the named scoped test command,
observed an assertion failure (exit 1), then restored source bytes/DB constraints.
**28/28 mutants were detected.** Nine touched source files were byte-for-byte
restored; the final 480-test suite and schema checks ran after restoration.
Mutation runs used only the disposable database. They were not typecheck failures
or inherited test-name claims.

For #128 specifically: accepting the unusable repair changed `failed` to
`generated`; dropping primary accounting changed **0.0075 MXN to 0**; replacing
the original reason exposed `usage_invalid`/`pricing_unavailable` instead of
`invalid_output`. For #129, ignoring the halt dispatched **2 free / 9 paid** calls
instead of one through the actual adapter; zeroing exposure broke both tiers'
nonzero-spend assertions.

The following patterns select real test names with:
`npx tsx --test --test-timeout=20000 --test-name-pattern='<pattern>' <suite>`.
Integration patterns also set `RUN_INTEGRATION_TESTS=1` and local `DATABASE_URL`.

| Mutation | Suite | Test-name pattern | Result |
| --- | --- | --- | --- |
| `128-accept-unusable-repair` | `tests/readings-pipeline.test.ts` | `#128` | Assertion failure; restored |
| `128-drop-primary-receipt` | `tests/readings-pipeline.test.ts` | `#128 repair branch: a repair that reports invalid usage` | Assertion failure; restored |
| `128-replace-original-reason` | `tests/readings-pipeline.test.ts` | `#128` | Assertion failure; restored |
| `129-disable-run-halt` | `tests/readings-safety-regression.test.ts` | `#129 real adapter` | Assertion failure; restored |
| `129-zero-unknown-exposure` | `tests/readings-safety-regression.test.ts` | `#129 real adapter` | Assertion failure; restored |
| `permit-send-before-reservation` | `tests/readings-service.test.ts` | `withdrawal between committed permit` | Assertion failure; restored |
| `consent-skip-admission-recheck` | `tests/readings-service.test.ts` | `withdrawal before permit` | Assertion failure; restored |
| `consent-ignore-revision` | `tests/readings-service.test.ts` | `deadline, configuration change and consent re-grant` | Assertion failure; restored |
| `consent-skip-publication-recheck` | `tests/readings-service.test.ts` | `withdrawal during primary` | Assertion failure; restored |
| `consent-stale-grant-overwrites-withdrawal` | `tests/readings-service.test.ts` | `consent: affirmative versioned grant` | Assertion failure; restored |
| `lifetime-stale-owner` | `tests/readings-service.test.ts` | `crash recovery` | Assertion failure; restored |
| `money-reset-cumulative-exposure` | `tests/readings-service.test.ts` | `settlement is idempotent` | Assertion failure; restored |
| `money-allow-next-after-unknown` | `tests/readings-service.test.ts` | `settlement is idempotent` | Assertion failure; restored |
| `money-settle-twice` | `tests/readings-service.test.ts` | `settlement is idempotent` | Assertion failure; restored |
| `publication-eager-config-check` | `tests/readings-service.test.ts` | `finalization rechecks configuration` | Assertion failure; restored |
| `transport-extra-256-tokens` | `tests/readings-safety-regression.test.ts` | `adapter never enlarges` | Assertion failure; restored |
| `transport-quote-incomplete-input` | `tests/readings-transport-safety.test.ts` | `quote and send use the same` | Assertion failure; restored |
| `transport-clear-timeout-at-headers` | `tests/readings-transport-safety.test.ts` | `timer covers a stalled body` | Assertion failure; restored |
| `transport-ignore-size-limit` | `tests/readings-transport-safety.test.ts` | `reject oversized bodies` | Assertion failure; restored |
| `privacy-forward-raw-fields` | `tests/readings-transport-safety.test.ts` | `outbound digest drops` | Assertion failure; restored |
| `privacy-drop-processor-provenance` | `tests/readings-transport-safety.test.ts` | `processor swap` | Assertion failure; restored |
| `privacy-wire-shared-cache` | `tests/readings-service.test.ts` | `live service never accesses` | Assertion failure; restored |
| `privacy-log-vendor-exception` | `tests/readings-service.test.ts` | `real adapter transport failures` | Assertion failure; restored |
| `chart-save-implicit-generation` | `tests/readings-service.test.ts` | `chart creation is chart-only` | Assertion failure; restored |
| `status-get-implicit-generation` | `tests/readings-service.test.ts` | `chart creation is chart-only` | Assertion failure; restored |
| `deadline-ignore-dispatch-expiry` | `tests/readings-service.test.ts` | `deadline, configuration change and consent re-grant` | Assertion failure; restored |
| `database-drop-lifetime-unique` | `tests/readings-service.test.ts` | `database constraints independently` | Assertion failure; restored |
| `database-delete-consumed-run-with-chart` | `tests/readings-service.test.ts` | `individual deletion during HTTP` | Assertion failure; restored |


## Author self-review / PR preparation

**One story:** make explicit lifetime-free generation consented, durable and
accounted, while retaining deterministic chart access and keeping generation off.
The change intentionally exceeds the usual 400-line preference: migration,
accounting/transport boundary, routes/consent UI, destructive-race tests and
operator runbook need to agree. Generated snapshot and the approved plan account
for substantial non-runtime size. No workflow/auth-password/checkout refactor is
bundled; the unrelated #140 branch was neither used nor modified.

- **SEC-01 path:** traced chart-only save and consent → verified ownership →
  lifetime claim → exact prepared request → durable admission → pre-send assertion
  → bounded HTTP → settlement → fenced publication. Traced thrown transport,
  unusable usage, overrun, ledger/publication failure, cancellation, deletion and
  repeat paths. Error/accounting state survives without a document.
- **SEC-02 boundaries:** no caller-controlled user/tier/model/price/provider/digest;
  strict small control bodies, ownership and server-derived allowlisted facts;
  en/es affirmative consent and withdrawal, origin guard/no-store/rate limits.
- **SEC-03:** no `.github/` changes, no lowered gates or skipped integration tests.
- **SEC-04/05:** actual pinned imports/type generation/build and real-PG/fake-HTTP
  tests pass. `maxDuration=60` and all prompt assets are in the built route.
- **SEC-06/07:** reuse lifecycle lease, rate-limit, auth, chart, document and logging
  infrastructure. Required execution capability has no production no-op default.
  Tests use an explicitly simulation-only helper; it is not imported by app code.
  Fresh mutants above distinguish spend estimates from receipts and fail on bugs.
- **Migrations:** additive new unpublished `0006`, SQL/journal/snapshot/manifest
  reviewed together; original snapshot tables unchanged. Fresh and upgrade
  rehearsals, constraints/FKs/readiness and conservative adoption exercised.
  Hosted rehearsal/production promotion are not authorized or completed.
- **Privacy/deletion/cache:** only minimal owned state and labelled usage/cost in
  new ledger; new state cascades with account, consumed runs survive chart
  deletion. Live shared cache disabled; legacy retention is explicitly unresolved,
  not represented as erased/anonymous. No raw provider errors in public status.
- **Performance:** bounded attempts, payload/response sizes and timeouts; indexed
  run/user/FK lookups, bounded four-row attempt ledger; no app connection retained
  during HTTP. Actual deployed pool concurrency/latency are not proven locally.
- **Config/docs:** all nine reading config variables documented in every template;
  flag remains off and credentials last. Readiness counts, legacy privacy/monthly
  quota/accounting guidance and deployment/recovery instructions reconciled.
- **Dependencies:** no dependencies or lockfile changes. `npm audit` was not run
  in this slice (not an added-dependency approval or a claim of a clean audit).
- **Freshness/overlap:** fetched staging still equals the base SHA above. Listed
  all 14 open PRs and fetched each file list: #140, #123, #35, #34, #33, #32, #31,
  #30, #29, #28, #27, #26, #25, #24. No file overlap, including the documentation
  changes. No merge-order coordination needed at that observation; refresh before
  any future filing if the base/open PRs move.

### Deviations and remaining gates

- Shared live cache is intentionally restricted to per-run memory, as approved;
  a tokenizer approximation is replaced by reserving a verified full model input
  cap. The real contract still requires later provider evaluation.
- Minimal consent/status controls ship now; generated page/PDF prose integration,
  paid generation, broader #104/#108 requirements and retention/export remain open.
- Public status uses canonical `readingId`/`documentId` plus lifecycle status rather
  than a separate `existing` discriminator. Repeats are a read-only no-op.
- Crash recovery is tested by constructed committed DB states and separate pools,
  not a real process-kill/serverless timeout. The full planned mutation matrix is
  represented by 28 concrete variants, not an exhaustive proof of all races.
- **Not verified:** browser click/hydration/visual/accessibility behavior; hosted
  migration/old-instance drain/rollback restore; real model prices, billing caps,
  latency/output quality; provider/privacy/retention contracts; hosted cancellation.
  These are explicit rollout/activation boundaries, not claims of passed checks.

No known unaddressed runtime blocker was found in this author pass. That is not
an independent or posted review verdict. Validation preceded commit/push, which the
operator subsequently authorized. No PR, GitHub issue update, merge, hosted change,
credential setup, or production promotion was performed as part of this validation.
A later authorized PR should be `deploy:required`, target staging, cite this
report at its actual implementation SHA, and keep generation disabled. Do not
close #104/#108 wholesale or present this as activation approval.
