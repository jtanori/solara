# PR #148 — review fixes and author verification

**PR:** <https://github.com/jtanori/solara/pull/148>
**Branch/base:** `arena/83b33a0a-solara` / `staging@2c0c64b202fdbf7a9e8f7d91aadc8b950866f14e`
**Code/test validation anchor:** `3ffde7fefd339dc55bc5c178363a320ff57f51e6` (the following report/runbook edits are documentation-only).

This is an **author repair report**, not an independent review or a new reviewer
verdict. The posted [AI-assisted review](https://github.com/jtanori/solara/pull/148#pullrequestreview-5929578969)
and [CHANGES REQUESTED verdict](https://github.com/jtanori/solara/pull/148#issuecomment-6932220719)
reviewed `4c384e6d7f6da9b8465a424011cbe6f92ce8d558`. The seven findings were accepted
and fixed on this same branch; the original review is not rewritten. Its initial
green CI / 480-test result did not detect these defects. Current CI and posted
responses are tracked on the PR, not inferred from that historical result.

Generation stays off outside isolated synthetic tests. No merge, issue closure,
hosted migration/settings change, manual deployment/promotion, credential setup,
real provider call or activation was performed. Existing session authorization
covered these local fixes/reruns; normal automatic PR checks are tracked separately.

## Findings, fixes and failing regression witnesses

| Finding | Fix commit | Implemented boundary and regression evidence |
| --- | --- | --- |
| **R1 / High** [4592984117](https://github.com/jtanori/solara/pull/148#discussion_r4592984117) | `ace0ca0` | Non-2xx and HTTP-200 error envelopes carry a `providerError` marker. A valid receipt still settles **measured** with `provider_error`, then halts without returning a completion; unknown/unpriceable receipts retain exposure. HTTP 500, HTTP 429, error envelope and repair-failure service regressions, plus free/paid pipeline regressions, all failed before the fix (**6/6**). They now assert one primary call (or exactly two when failure is in repair), measured receipts, no later section/replay, and no vendor-body leak. |
| **R2 / High** [4592984125](https://github.com/jtanori/solara/pull/148#discussion_r4592984125) | `b97bbb5` | Preserve the document/outcome through fallback finalization and `finally`; throw a stable error **after** cleanup when the result is wholly unused. Post-claim withdrawal, disablement, deletion, preparation rejection and exception each failed before the fix (**5/5**). Now non-2xx responses leave no permit/consumption, clear the owner and allow explicit recovery of the same unused run/initial locale. Post-permit failure/no-replay behavior remains intact. |
| **R3 / High** [4592984144](https://github.com/jtanori/solara/pull/148#discussion_r4592984144) | `aa97385` | Normalize surrounding spaces; reject blank, control-containing or non-visible-ASCII/internal-whitespace API keys. Require an own served-model list and price the full input cap plus 2,000 output tokens before availability or claim. Four new tests failed before the fix. Coverage includes CR/LF/NUL/tab, inherited `constructor`, exact 5 MXN acceptance, one micro-MXN over, unrepresentable cost and actual normalized Authorization headers. Invalid config creates no claim and sends nothing. |
| **R4 / Medium** [4592984162](https://github.com/jtanori/solara/pull/148#discussion_r4592984162) | `fb53f75` | Chart deletion has its own `readings:delete:user` / `readings_delete_user` budget, **30/hour**, independent of consent's 20/hour. Both directional exhaustion tests failed before the fix (**2/2**); afterward 30 actual chart deletions plus a 429 still permit consent withdrawal, and consent throttling does not prevent deletion. Retry-After/no-store, log kind and window length are asserted. |
| **R5 / Medium** [4592984172](https://github.com/jtanori/solara/pull/148#discussion_r4592984172) | `de2fae2`, strengthened by `3ffde7f` | Dispatch and adapter use rounded nonnegative `performance.now()` deltas. Pre-send failures preserve `GenerationBlocked.code`; only actual abort becomes `generation_cancelled`, unknown local exceptions become `generation_unavailable`. Initial targeted run: **14 failures / 1 passing abort control**. Real-PG measured/unpriceable/thrown settlements survive backward `Date.now()` steps; deterministic tests additionally prove positive fractional rounding and negative clamping on all dispatch branches and HTTP 200/500. Positively unsent money remains zero while the offer stays consumed. |
| **R6 / Medium** [4592984191](https://github.com/jtanori/solara/pull/148#discussion_r4592984191) | `b36c36d` | A shared own-property-safe predicate is independently enforced at durable settlement against **the attempt row's requested model**, not merely any priced model. Both tests failed before the fix (**2/2**). Direct settlement with a priced strong model rejects without releasing the cheap-model reservation; a legitimate alias settles; conflicting duplicates remain idempotent; inherited properties cannot admit a model. |
| **R7 / Medium** [4592984197](https://github.com/jtanori/solara/pull/148#discussion_r4592984197) | `cea35f7` | Unpublished `0006` and the actual operator aggregate SQL require exact `en`/`es`. The pre-fix upgrade rejected the unsupported-locale INSERT. It now preserves four unsupported documents (`fr`, `es-MX`, empty, and earlier `pt` on a qualifying account), selects the later valid canonical document, leaves other accounts unused and invents no consent/receipts. The runbook query itself is executed by the test: 10 surviving documents, 2 qualifying, 2 fixture/mixed, 6 ambiguous, 1 qualifying account, 9 without qualifying evidence. |

`3ffde7f` also fixes test-only typing of the optional `prepare` hook and makes the
invalid-configuration assertion boolean so Node's test runner can serialize its
failure safely. No production interface was weakened to accommodate a test.

## Final executed local checks

All checks below used synthetic accounts/charts, fake HTTP transport and a newly
created **disposable loopback database**, `solara_pr148_fixes`. Earlier databases
and their applied migration hashes were not rewritten. `0006` is unpublished;
its new manifest hash is
`7052c0d61022ad92a58d62053f2c9f965cf2f006c4f1fda107061781eb1c8525`.

Environment for the final command runs:

```sh
export DATABASE_URL=postgresql://solara@127.0.0.1:5438/solara_pr148_fixes
export DATABASE_URL_DIRECT="$DATABASE_URL"
export APP_URL=http://localhost:3000
export READINGS_GENERATION_ENABLED=false
export NEXT_TELEMETRY_DISABLED=1
```

| Exact command/check | Observed result |
| --- | --- |
| `npm run db:manifest` then `npm run db:manifest:check` | Regenerated unpublished migration hash; manifest matches. |
| `npm run db:migrate` on the new empty database | Seven migrations applied; no pending entries. |
| `npm run db:check` | **16/16 tables, 62/62 required columns, 9/9 indexes**, no pending or unexpected journal hashes; repeated after mutation restoration. |
| `npx next typegen` | Passed. |
| `npm run typecheck` | Passed after fixing the test-only optional-method mock overload; also rechecked after generated-only `next-env.d.ts` restoration. |
| `npm run lint` | Passed. |
| `RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts` | **519 passed, 0 failed/cancelled/skipped**, 342211.198197 ms. |
| Scoped service/migration/transport/safety/adapter/pipeline command below | **122 passed, 0 failed/cancelled/skipped**, after mutation restoration. |
| `npm run build` | Passed with generation explicitly false; generate route traces **23/23** prompt markdown files. |
| Built production-server HTTP/SSR smoke in en/es | Passed actual authenticated chart save, reading HTML, PDF, consent grant/withdrawal, status, canonical repeat/deletion, no-store, origin rejection, health and readiness. **4 fake calls when enabled / 0 when disabled**. Temporary servers stopped; synthetic accounts/sessions and relevant throttles removed. |
| `npm audit --omit=dev --audit-level=high --json` | Exit 0, **0 vulnerabilities**. |
| `npm audit --json` | Exit 1, **11 moderate / 0 high / 0 critical**, all affected packages development-only. Packages/lockfile unchanged from base; this broader audit is **not clean**. |

The scoped command actually run was:

```sh
RUN_INTEGRATION_TESTS=1 npx tsx --test \
  tests/readings-service.test.ts tests/readings-migrations.test.ts \
  tests/readings-transport-safety.test.ts tests/readings-safety-regression.test.ts \
  tests/readings-adapter.test.ts tests/readings-pipeline.test.ts
```

Final full-suite output:

```text
1..519
# tests 519
# suites 0
# pass 519
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 342211.198197
```

There are now **43 real-PG service tests**; this follow-up adds **39 tests** overall
and strengthens existing withdrawal/migration checks. Dependencies were already
installed with `npm ci --no-audit --no-fund` during the initial work; `npm ci` was
not rerun locally merely for these source-only fixes. CI will install from the
unchanged lockfile. HTTP smoke is not browser/hydration/visual/accessibility QA;
its synthetic fetch preload is temporary, ignored, and not shipped.

### Failed checks corrected, not hidden

- The first typecheck found Node's `mock.method` overload does not accept optional
  `ReadingProvider.prepare`. The test now replaces only its local provider's
  function, preserving production types. Full static/build checks subsequently pass.
- The first mutation classifier reported **53/54**: the invalid-key test did fail,
  but Node serialized an assertion containing a function-bearing config object as
  `ERR_TEST_FAILURE`, not `ERR_ASSERTION`. A boolean availability assertion preserves
  the same expectation without serializing that object. The entire matrix was
  rerun: **54/54 explicit assertion failures**, all restored. No surviving mutant
  was relabelled as caught without a new run.
- The pre-fix red runs above are evidence of the defects, not included in the final
  green totals. No test was disabled or threshold lowered.

## Author repair self-review and limits

Read the repair diff and traced each changed boundary through real service/store
callers. The review suggestions were adapted to the actual APIs (`costMicros`
argument order, config constants, existing fallback finalization) rather than
copied blindly. Provider-error measurement remains separate from successful output;
overrun/unknown accounting, #128's primary failure and #129's halt remain protected.
R2 cannot swallow its own error in the fallback catch. R3 performs no network/key
validation call. R4 does not relax the consent throttle. R6 rejects before any
ledger update. R7 preserves unsupported historical rows rather than rewriting them.

- **SEC-01/02:** no new caller-supplied identity/model/tier/provider path; ownership,
  consent, immutable lifetime consumption, payload/log privacy and no-store remain.
- **SEC-03/06:** no workflow, dependency, checkout/password or unrelated branch
  change; reuse the existing rate limiter, store and integer cost calculation.
- **SEC-04/05/07:** checks above are re-executed, not inherited from the initial
  green head; mutation witnesses below exercise behavior, not compilation errors.
- **Migration:** local fresh install and populated upgrade passed, with the actual
  pre-migration operator query cross-checked. Existing schema snapshots did not
  change; only the unpublished adoption predicate/hash changed.
- **Freshness/overlap:** fetched staging remains the base above; all 14 other open
  PR file lists were checked, with no overlap. The fixed Arena branch is retained;
  no rebase, force push, other branch update or #140 integration.
- **Audit limitation:** the unchanged dev-only moderate advisories remain visible;
  no blanket dependency update or unsafe downgrade is bundled.
- **Not verified/authorized:** browser interaction; hosted migration, old-instance
  drain, backup/restore, runtime cancellation/concurrency; actual provider prices,
  token contract, invoice behavior, model quality or latency. Page/PDF generated
  prose, paid generation and legacy retention remain later work.

`deploy:required` remains correct. Neither this author repair report nor resolving
an addressed inline finding constitutes a new reviewer verdict or permission to
merge/deploy/enable generation. No additional independent-identity gate is added.

## Mutation evidence — refreshed on the repaired code

**54/54 detected:** the original 28 safety/accounting mutants were rerun, plus
26 mutants targeting these seven findings. Each row produced a named assertion
failure with exit 1; source/SQL/docs bytes and DB guards were restored afterward.
All **13 mutated files** were independently SHA-256 checked against their saved
bytes. The lifetime unique index and reading FK `ON DELETE SET NULL` were also
independently inspected after restoration. The full 519-test run and schema/build
checks above ran only after restoration.

The table names the exact test selection; commands were:
`npx tsx --test --test-timeout=20000 --test-name-pattern='<pattern>' <suite>`.
DB selections also set `RUN_INTEGRATION_TESTS=1` and the disposable URLs above.
The two DB-constraint mutants deliberately dropped the lifetime unique index or
changed the reading FK to CASCADE, then restored the original constraints; they
never touched hosted data. The R7 SQL mutant operates only on the upgrade test's
newly created database, not by changing an applied journal hash.

| Mutation | Suite | Test-name pattern | Observed result |
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
| `R1-non-2xx-loses-error-marker` | `tests/readings-service.test.ts` | `PR148 R1: HTTP` | Assertion failure; restored |
| `R1-envelope-loses-error-marker` | `tests/readings-service.test.ts` | `PR148 R1: error envelope` | Assertion failure; restored |
| `R1-no-halt-after-measured-error` | `tests/readings-safety-regression.test.ts` | `PR148 R1` | Assertion failure; restored |
| `R1-valid-error-receipt-becomes-unknown` | `tests/readings-service.test.ts` | `PR148 R1` | Assertion failure; restored |
| `R2-unused-claim-returns-success` | `tests/readings-service.test.ts` | `PR148 R2` | Assertion failure; restored |
| `R2-lose-section-failure-code` | `tests/readings-service.test.ts` | `PR148 R2: post-claim disable` | Assertion failure; restored |
| `R3-accept-header-unsafe-key` | `tests/readings-service.test.ts` | `PR148 R3: blank` | Assertion failure; restored |
| `R3-do-not-normalize-key` | `tests/readings-service.test.ts` | `PR148 R3: surrounding` | Assertion failure; restored |
| `R3-accept-inherited-served-list` | `tests/readings-service.test.ts` | `PR148 R3: inherited` | Assertion failure; restored |
| `R3-ignore-unrepresentable-quote` | `tests/readings-service.test.ts` | `PR148 R3: affordable` | Assertion failure; restored |
| `R3-ignore-affordability` | `tests/readings-service.test.ts` | `PR148 R3: affordable` | Assertion failure; restored |
| `R3-quote-without-output-cap` | `tests/readings-service.test.ts` | `PR148 R3: affordable` | Assertion failure; restored |
| `R4-delete-spends-consent-quota` | `tests/readings-service.test.ts` | `PR148 R4` | Assertion failure; restored |
| `R4-deletion-quota-too-low` | `tests/readings-service.test.ts` | `PR148 R4: exhausted chart` | Assertion failure; restored |
| `R5-execution-wall-clock` | `tests/readings-safety-regression.test.ts` | `PR148 R5: .* settlement rounds` | Assertion failure; restored |
| `R5-execution-no-rounding` | `tests/readings-safety-regression.test.ts` | `PR148 R5: .* settlement rounds` | Assertion failure; restored |
| `R5-execution-negative-latency` | `tests/readings-safety-regression.test.ts` | `PR148 R5: .* settlement rounds` | Assertion failure; restored |
| `R5-adapter-wall-clock` | `tests/readings-transport-safety.test.ts` | `PR148 R5: HTTP` | Assertion failure; restored |
| `R5-adapter-no-rounding` | `tests/readings-transport-safety.test.ts` | `PR148 R5: HTTP` | Assertion failure; restored |
| `R5-adapter-negative-latency` | `tests/readings-transport-safety.test.ts` | `PR148 R5: HTTP` | Assertion failure; restored |
| `R5-erase-permit-code` | `tests/readings-safety-regression.test.ts` | `PR148 R5: unsent permit` | Assertion failure; restored |
| `R6-accept-priced-unadmitted-model` | `tests/readings-service.test.ts` | `PR148 R6: direct settlement` | Assertion failure; restored |
| `R6-check-reported-not-requested-model` | `tests/readings-service.test.ts` | `PR148 R6: direct settlement` | Assertion failure; restored |
| `R6-admit-inherited-model` | `tests/readings-service.test.ts` | `PR148 R6: durable served` | Assertion failure; restored |
| `R7-adopt-unsupported-locale` | `tests/readings-migrations.test.ts` | `PR148 R7` | Assertion failure; restored |
| `R7-classification-counts-unsupported-locale` | `tests/readings-migrations.test.ts` | `PR148 R7` | Assertion failure; restored |
| `database-drop-lifetime-unique` | `tests/readings-service.test.ts` | `database constraints independently` | Assertion failure; restored |
| `database-delete-consumed-run-with-chart` | `tests/readings-service.test.ts` | `individual deletion during HTTP` | Assertion failure; restored |
