# Saved-reading presentation — implementation evidence

Author verification for the approved [page/PDF design](plan-free-reading-page-pdf.md), not an independent review or activation decision. The source baseline is `13a886085aaa901b964e323fe3d2187650be8881`; the approved plan was committed as `8175c9e` on `arena/78f55298-solara`.

## Checkpoint: read model and persistence boundary

Implemented at this checkpoint:

- Minimal shared presentation types and bilingual notices/catalog; frozen synthetic en/es free, partial and full paid documents.
- A bounded persisted-document decoder with row/envelope agreement, free-tier key checks, safe partial/failure/unknown-block handling and no private metadata projection.
- Owner-scoped canonical selection, pinned selectors, historical/deleted/other-chart/unavailable states and a final ownership check for the later PDF route.
- Independent chart access when generation tables are absent; no hidden adoption, repair, generation, consent or allowance writes.
- Bounded legacy-note reads and an explicit notes projection; paid subscription affects only that legacy projection.
- Behavior-preserving extraction of the existing generation-status mapper. No publication, admission, spend, consent, transport, migration or provider configuration changes.

The page, PDF and client refresh integration are **not completed by this checkpoint**. This is not a claim to close #104 or #106.

## Executed checks

Disposable loopback PostgreSQL **16.2**, Node **22.22.3**, synthetic accounts/documents, fake providers only. `READINGS_GENERATION_ENABLED=false` for the reader; existing service tests explicitly use their isolated fake-provider seams.

| Check | Result |
| --- | --- |
| `npm ci --no-fund` | Completed; existing 11 moderate audit findings reported, no blanket dependency changes |
| Local `npm run db:migrate` / `npm run db:check` | 7 migrations; 16 tables / 62 columns / 9 indexes; no pending/unexpected hashes |
| `npx tsx --test tests/readings-presentation.test.ts` | 20 passed |
| `RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts tests/readings-service.test.ts` | 79 passed, 0 failed, 0 skipped |
| `npx next typegen` / `npm run typecheck` | Passed after fixing nullable lookup inference with `Array.at(0)` |
| Scoped ESLint on the new modules/tests and changed store/notes helpers | Passed |
| Deliberate mutations below | 17/17 caught by assertions; four source files byte-for-byte restored |

The initial service-suite invocation omitted `RUN_INTEGRATION_TESTS=1` and skipped 43 cases; it is **not** counted as service verification. The corrected invocation above ran all 79 tests with no skips. Full-suite/build/browser/PDF and hosted resource evidence remain subsequent gates, not implied by these scoped results.

## Defect mutations

Each mutation was applied alone, followed by:

```bash
node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts
```

The environment was an explicitly disposable loopback database. Each run produced an `ERR_ASSERTION` failure, not an import/transformation error; each source was restored before the next mutation. No test expectations were edited for mutants.

| Mutation | Guard that failed |
| --- | --- |
| Remove owner filters from both chart and snapshot lookups | Cross-owner reads rejected |
| Disable the pinned-ID mismatch rejection | Pinned document never substitutes another row |
| Remove run/document locale agreement | Mismatched canonical run unavailable |
| Remove run/document content-version agreement | Mismatched canonical run unavailable |
| Accept a pointer on a running/unpublished run | Published-state coherence |
| Replace the SQL JSON-size predicate with `true` | Oversize payload is not transferred to Node |
| Add a network fetch to the reader | Stubbed fetch counter remains zero; no real HTTP call is permitted by the test |
| Remove the free-section key restriction | Paid section in free document rejected |
| Remove duplicate-key rejection | Duplicate sections rejected |
| Disable row/envelope identity comparison | Every identity/version dimension agrees |
| Drop saved closing questions | Frozen question parity |
| Turn unknown blocks into visible prose | Unknown payload absent; siblings preserved |
| Spread raw JSON into the display projection | Metadata/paid-teaser sentinels absent |
| Disable decoder byte bound | Oversize UTF-8 JSON rejected |
| Disable aggregate display-text bound | Many individually valid blocks still bounded |
| Mark every preview available/not-included rather than planned | Profections/transits truthfully marked planned |
| Ignore expiry in reserved-run status | Original generation-status semantics preserved |

## Review and operational boundaries

PR148's [final verdict](https://github.com/jtanori/solara/pull/148#issuecomment-6936495944) is MERGEABLE with one low, non-blocking empty query/fragment URL observation. That provider-configuration follow-up is not bundled here. Its review stays pinned to `15569e6` / equivalent merged `13a8860`; these new changes require their own validation/review.

No hosted database, credentials, environment settings, deployment, generation activation, real AI request, email QA, issue closure or production promotion was performed. The hosted isolation/drain/recovery/migration/readiness prerequisites remain unchanged.
