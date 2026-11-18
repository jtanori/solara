# PR #151 — five-finding remediation and verification

## Revision and review boundary

- Reviewed baseline: **`86249dadb27631773e97ef5a11d8cd265de7f1c7`**.
- [AI-assisted review 5950072988](https://github.com/jtanori/solara/pull/151#pullrequestreview-5950072988)
  and [changes-requested verdict](https://github.com/jtanori/solara/pull/151#issuecomment-6967456901).
- Fix commits: **`c1364d2`** (Picomatch) and **`14c368e`** (paid paths, identity and pagination).
- **All final code/test evidence below is executed at
  `14c368ea735fc23d5da4f1e082b739091fbd75ab`.** This report is committed afterward;
  subsequent report-only changes do not change those tested bytes.
- Branch `arena/d350cb2e-solara`; freshly fetched staging and merge-base remain
  **`e79671a6658b82a1867afdb30cbcaae4b6481bed`** after the final validation.

All five findings are implemented, with no deferrals. This is **author remediation
and self-review evidence**, not a replacement reviewer verdict or merge approval.
The five review threads remain unresolved for review of the fixed head. Generation
and shared control remain off; no hosted state, live provider/Stripe call, manually
requested deployment, staging/production rollout, merge or promotion was performed.

## 1. Durable provider-error recovery — High

[Finding 4608579129](https://github.com/jtanori/solara/pull/151#discussion_r4608579129)

`paidRecoveryHalt` classifies the **entire** durable attempt/checkpoint ledger,
not just the current section. Both the worker and transactional permit admission
apply it before any further primary or repair. Only `measured` / `code=measured`
with a persisted valid/invalid checkpoint permits progress. A settled provider
error, a positive `not_dispatched` halt, or a measured receipt without a checkpoint
halts further spending. Reserved/unknown exposure stays blocked and is never replayed.

The existing finalization fences decide whether already validated sections can
publish as partial. With no valid output, the run fails without refunding its
consumed allowance. Receipt costs are retained exactly; a restart is not authority
to retry, discard an error, or bypass ownership/consent/control/lease checks.

Real-DB regressions cover **primary and repair** settlements, with and without
prior valid output, for provider errors, missing checkpoints and no-send halts.
Provider-error cases use the actual adapter/dispatch/settlement with fake HTTP,
then simulate death before handling the committed halt. Recovery makes **zero
additional sends**, preserves every receipt/cost, and yields the expected partial
or no-output result. Private provider error text is absent from stored state.
A separate test directly calls permit admission to verify the defense there too.

## 2. Entitlement loss during authorized transport — High

[Finding 4608579142](https://github.com/jtanori/solara/pull/151#discussion_r4608579142)

Heartbeat now uses **lease/publication authorization**, without requiring current
subscription entitlement. Owner, chart, consent, deadline/lease, Stop, shared
control/revision, configuration/content version and editorial checks remain.
Preparation, permit admission and the immediate pre-send assertion still require
current entitlement. Losing access is not the same event as withdrawing consent
or stopping a run.

Timed real-DB/fake-transport tests wait for an actual five-second heartbeat after
expiry or revocation during the second permitted call. That response settles as
measured, no third send occurs, and a pinned partial edition with two validated
sections and **0.015 MXN measured / 0 uncertain** is available through the common
page/PDF projection and actual PDF renderer. Between-call expiry/revocation also
blocks both the next primary and a repair. Withdrawal and stale ownership still
abort the held transport; uncertain exposure remains reserved and no edition is
published. Existing Stop/deletion/disablement/deadline and every-dispatch guards
are covered by the refreshed full suite and paid mutation group.

## 3. Locale-independent identities and legacy readback — Medium

[Finding 4608579145](https://github.com/jtanori/solara/pull/151#discussion_r4608579145)

The new **`json-utf16-v1`** scheme normalizes JSON values and recursively serializes
keys in UTF-16 code-unit order. Arrays preserve order; there is no locale/ICU or
Unicode normalization. Direct key serialization also avoids JavaScript silently
reordering integer-like properties. The paid fingerprint canonicalizes the actual
base profile/settings rather than wrapping the free path's insertion-sensitive
fingerprint. Free identity/content-version behavior is unchanged.

Identity transitions are explicit:

- New core/rich snapshots use **`paid-snapshot/3` / `paid-snapshot/4`**, with the
  same core/rich section contracts and calculation policies.
- Original snapshot versions **1/2** retain their exact hashes and immutable
  read access. Their validated schemas have fixed ASCII-letter keys, no numeric
  or case-colliding keys. A locale-independent, case-folded field ordering
  reproduces the original ordering for those schemas only; it is not reused for
  new arbitrary JSON/configuration. Pre-fix golden hashes are committed in
  `tests/fixtures/readings/paid-snapshot-hashes-v0.json`.
- Paid config hashes include the new scheme; editorial content policy is
  `paid-editorial/2`. Evaluation/review envelopes become
  **`paid-evaluation/2` / `paid-editorial-review/2`**. Old approvals/reports and
  pending generation authority are not re-signed/adopted. Fresh exact-version
  evidence is required. Consumed or uncertain allowances are not reset.
- No schema migration, SQL history rewrite or saved-edition overwrite is needed.
  The inspected **local disposable** DB initially had zero paid runs, snapshots,
  editions and approvals. Hosted absence was **not** inspected or assumed.
  Existing immutable snapshots are supported regardless; any later authorized
  rollout must keep control off and drain/reconcile pending attempts, as the
  [runbook](setup/10-paid-readings.md#identity-and-compatibility) explains.

Separate processes started with `LANG`/`LC_ALL` **en_US.UTF-8 and tr_TR.UTF-8**
produce identical config, contentVersion, offer, settings, snapshot, evaluation,
sample and corpus hashes with case-distinct `Index`/`index` models/aliases and
reversed nested insertion order. Actual JSONB edition and exact approval readback
works across processes without writes. Legacy editions retain their original
hashes even when the old approval is no longer eligible for generation.

## 4. Star-free repeated-extglob ReDoS — Medium

[Finding 4608579152](https://github.com/jtanori/solara/pull/151#discussion_r4608579152)

The `.2` backport was **insufficient**, despite a zero audit count. Its exact
`makeRe('+([ab]+)').test('a'.repeat(35) + '!')` failure was reproduced here under
a 1.5-second external child-process deadline; the process timed out and was killed.
That reproduction is **not** counted as an assertion mutation kill.

Private **`@solara/picomatch-v4@4.0.7-solara.3`** replaces the star blacklist with
an explicit conservative grammar: repeated extglobs may contain only 1–16 nonempty
ASCII literal words (`[A-Za-z0-9_-]+`) with distinct first characters after case
folding. This gives each iteration one possible branch consuming a fixed word.
All other repeated bodies become fully escaped literals, including character
classes/plus, nested groups, optional syntax, quotes/escapes, empty/overlapping
alternatives and excess branches. Recursion opt-out cannot disable the guard.

The readable source, metadata, **17,051-byte** npm archive, SHA-512 lock integrity,
provenance and installed-consumer checks were updated together with `npm pack`
and npm lock generation. Every source/installed/archive member is compared;
the documented parser block remains the only upstream source-code delta.
No registry Picomatch copy remains. All complete production lock objects are
unchanged from the reviewed baseline (and the original cleanup baseline).

The expanded **11-test** security suite exercises matcher, `makeRe`,
`parse`/`compileRe`, Micromatch/Tinyglobby/Fdir resolution, related
class/group/plus/optional/alternation forms and long attack inputs under a
**5-second external deadline / 64 MiB V8 old-space** bound (not an OS/RSS limit).
Positive ordinary/finite-repeat matching and real Fast-glob/Tinyglobby filesystem
calls remain functional. An additional differential probe ran **89,856 comparisons**
(468 tracked-name/synthetic paths × 16 ordinary patterns × 6 options × upstream
2.3.2/4.0.7), with **0 mismatches**. Deliberately restricted syntax is not claimed
semantically equivalent.

**Limit:** this is dev-tool glob hardening, not a demonstrated web exploit or a
proof that arbitrary regex/options/caller-supplied compiled states are linear-time.
The [explicit supported grammar and remaining threat model](../vendor/README.md)
are part of the fix. npm does not independently validate private-fork code;
zero audit output is supplemented by source, behavioral and mutation evidence.
Upstream still reports latest 4.0.7 at this check. [#150](https://github.com/jtanori/solara/issues/150)
tracks monitoring and replacement by a verified upstream fix, not a deferred
version of this finding.

## 5. Lossless paid-history pagination — Medium

[Finding 4608579159](https://github.com/jtanori/solara/pull/151#discussion_r4608579159)

Cursor existence remains owner/chart-scoped and invalid cursors are rejected.
The `(created_at, id)` boundary is now selected **inside PostgreSQL**, with the
same owner/chart predicates, rather than round-tripped through a JavaScript Date.
No timestamp is rounded; descending UUID ties remain deterministic.

Actual-handler/real-Postgres tests create **41 saved editions** in one millisecond,
then repeat with exactly equal timestamps and independent UUIDs. Both traverse
**20 / 20 / 1** rows, every edition exactly once in native SQL order, and reject
missing, other-chart and foreign-user cursors. Two new production-mode browser
cases exercise **Earlier requests → Back to recent** in English/Spanish across
21 microsecond-separated editions; reads preserve both free and paid ledgers.

## Final executed validation

Environment: **Node 22.22.3 / npm 10.9.8 / PostgreSQL 16.2 / Chromium 153.0.8010.0**.
Disposable loopback database only; dotenv disabled; synthetic accounts, fake
transport, no hosted credentials/customer data. Standing `full-validation=authorize`
covered the announced expensive commands and fixes/reruns.

| Check | Result at `14c368e` |
| --- | --- |
| Ordinary `npm ci` | **491 installed / 492 audited / 0 vulnerabilities** |
| `npm ls --all --json` | exit 0 |
| `npm audit --include=dev --json` | **0 vulnerabilities**, exit 0 |
| `npm audit --omit=dev --json` | **0 vulnerabilities**, exit 0 |
| `npx next typegen` / `npm run typecheck` / `npm run lint` | all pass |
| Complete suite, both integration flags | **737 passed / 0 failed / 0 skipped**, 444949.981294 ms |
| `npm run build` | pass, Next 16.4.5 production build and TypeScript |
| Dependency mutations | **13/13 assertion kills**, exact restoration, **11/11** restored security tests |
| Paid/annual/editorial/checkout mutations | **35/35 assertion kills**, exact restoration, **83/83** restored scoped tests, build and browser pass |
| Fresh production-mode browser after final full suite/build | **24 cases**, **0 provider fetches / 0 automatic POST/PUT** |
| `npm run db:manifest:check` | current |
| `npm run db:check` | **24 tables / 147 columns / 22 indexes**, no pending/unexpected migrations |
| Disabled `npm run readings:worker -- --once` | exit 0 |
| `node scripts/check-pdf-package.mjs` | **218 files / 5.9 MiB**, required assets present, no test/browser/extractor files |
| Final local shared control / approval rows | **false / 0** |
| `git diff --check` / restored worktree | pass / clean |

The final full suite/build/browser ran **after** both mutation runners restored
sources. Generated Next development/build type-import churn was restored, not
committed. During test development, typecheck caught a widened fixture literal;
a timed negative-control probe also needed to observe the worker's abort handler
rather than racing it from `finally`. Both test-harness issues were corrected
before the clean checkpoint and final runs; neither is counted as mutation evidence.

**Not relabeled as new evidence:** the older **59 presentation mutations** remain
pinned to `7d5549c` in [the historical feature record](paid-reading-verification.md).
Their page/PDF/free-presentation guard sources were not changed in this repair;
the current full suite and real-app page/PDF/browser checks were rerun. In contrast,
all 26 earlier paid mutations **were rerun**, together with nine new paid controls,
because worker/identity behavior changed. The old PDF resource benchmark, hosted
worker/migration/PDF qualification, genuine provider/editorial evidence, real Stripe
lifecycle/purchase and rollout remain unverified. Email remains deferred.

## Reproducing the local evidence

Provision a disposable PostgreSQL database on loopback first. Use its credentials
in `DATABASE_URL`; the example below is synthetic local infrastructure, never a
hosted account. From a clean committed checkout:

```bash
export DOTENV_CONFIG_PATH=/dev/null
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5438/paid_readings
export APP_URL=http://localhost:3000
export NEXT_TELEMETRY_DISABLED=1
export READINGS_GENERATION_ENABLED=false
export READINGS_PAID_GENERATION_ENABLED=false

npm ci
npm run db:migrate # needed when provisioning a fresh disposable database
node scripts/verify-dependency-mutations.mjs
node scripts/verify-reading-mutations.mjs --group=paid
npx next typegen
npm run typecheck
npm run lint
RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts
npm run build
npm run db:manifest:check
npm run db:check
npm run readings:worker -- --once
node scripts/check-pdf-package.mjs
npx tsx scripts/verify-reading-browser.ts
npm audit --include=dev --json
npm audit --omit=dev --json
npm ls --all --json
```

Runners demand a clean checkpoint, restore after each deliberate mutation and
refuse syntax/import/process-timeout failures as kills. Dependency negative
controls install old packages only in an ignored isolated test directory. All
new fixtures remain excluded from deployment; the small npm archive remains a
required installation input. No audit/CI/lint threshold was weakened.

## Self-review, overlap and release boundary

Reviewed each changed runtime, parser, package/provenance, test, mutation/browser
runner and documentation file. Traced recovery→authorization→admission→transport→
settlement→publication and pinned readback; checked no raw error persistence, no
new dispatch on reads, no transaction spanning provider HTTP and no authority
inferred from hash compatibility. The remediations do not alter existing SQL
migrations, env templates, workflows, production dependencies or provider budgets.
The large repair diff is predominantly regressions and evidence for five distinct
review findings, not an unrelated refactor or feature expansion.

Fresh overlap check still finds package PRs **#26–#35**; existing #27/#29
coordination and proposed PR151-first order remain. No other branch or PR was
modified, closed or merged. If staging moves, merge it normally into this fixed
session branch and rerun gates; do not rebase/force-push. The original PR's additive
0007/0008 hosted rehearsal and all activation/purchase gates remain. No new
independent-person/identity approval gate is introduced.

## Executed mutation table

The following rows are read from the two successful runner result files at the
validated revision. **Every row is an assertion kill, followed by restoration.**
Timeout reproductions are not listed as kills.

| Group / mutation | Executed test selector | Result |
| --- | --- | --- |
| Dependency / `removed-repeated-star-guard` | tests/dependency-security.test.ts — micromatch uses the patched matcher | assertion kill |
| Dependency / `star-quantifier-unprotected` | tests/dependency-security.test.ts — micromatch uses the patched matcher | assertion kill |
| Dependency / `star-only-guard-restored` | tests/dependency-security.test.ts — micromatch uses the patched matcher | assertion kill |
| Dependency / `ambiguous-literal-branches` | tests/dependency-security.test.ts — micromatch uses the patched matcher | assertion kill |
| Dependency / `case-fold-bypass` | tests/dependency-security.test.ts — micromatch uses the patched matcher | assertion kill |
| Dependency / `unbounded-branch-count` | tests/dependency-security.test.ts — micromatch uses the patched matcher | assertion kill |
| Dependency / `recursion-opt-out-bypasses-guard` | tests/dependency-security.test.ts — micromatch uses the patched matcher | assertion kill |
| Dependency / `incomplete-literal-escaping` | tests/dependency-security.test.ts — micromatch uses the patched matcher | assertion kill |
| Dependency / `all-matching-disabled` | tests/dependency-security.test.ts — ordinary matching | assertion kill |
| Dependency / `archive-integrity-corrupted` | tests/dependency-security.test.ts — vendored source, installed code and npm tarball | assertion kill |
| Dependency / `minimatch-10-restored` | tests/dependency-security.test.ts — minimatch bounds | assertion kill |
| Dependency / `esbuild-018-restored` | tests/dependency-security.test.ts — nested esbuild does not expose | assertion kill |
| Dependency / `archive-excluded-from-deployment` | tests/deployment-inputs.test.ts — deployment input keeps PDF | assertion kill |
| Paid / `paid-recovered-provider-error` | tests/paid-readings.test.ts — recovery never spends after settled .* provider_error | assertion kill |
| Paid / `paid-recovered-missing-checkpoint` | tests/paid-readings.test.ts — recovery never spends after settled .* missing_checkpoint | assertion kill |
| Paid / `paid-recovered-no-send-halt` | tests/paid-readings.test.ts — recovery never spends after settled .* not_dispatched | assertion kill |
| Paid / `paid-admission-durable-halt` | tests/paid-readings.test.ts — permit admission independently | assertion kill |
| Paid / `paid-heartbeat-entitlement-abort` | tests/paid-readings.test.ts — in-flight heartbeat: (expiry\|revocation) | assertion kill |
| Paid / `paid-canonical-process-locale` | tests/paid-identity.test.ts — paid identity is identical | assertion kill |
| Paid / `paid-base-insertion-order` | tests/paid-identity.test.ts — paid identity is identical | assertion kill |
| Paid / `paid-legacy-snapshot-rehashed` | tests/paid-identity.test.ts — paid identity is identical | assertion kill |
| Paid / `paid-cursor-js-date-truncation` | tests/paid-readings.test.ts — paid history microseconds | assertion kill |
| Paid / `paid-owner-scope` | tests/paid-readings.test.ts — foreign and legacy paid rows | assertion kill |
| Paid / `paid-entitlement-each-call` | tests/paid-readings.test.ts — entitlement is checked before paid calculation | assertion kill |
| Paid / `paid-consent-each-repair` | tests/paid-readings.test.ts — settled invalid checkpoint | assertion kill |
| Paid / `paid-shared-revision` | tests/paid-readings.test.ts — repair itself requires current consent | assertion kill |
| Paid / `paid-owner-fence` | tests/paid-readings.test.ts — settled checkpoint survives crash | assertion kill |
| Paid / `paid-lease-deadline` | tests/paid-readings.test.ts — settled invalid checkpoint | assertion kill |
| Paid / `paid-rich-repair-budget` | tests/paid-readings.test.ts — rich paid worst-case preflight | assertion kill |
| Paid / `paid-warm-content-version` | tests/paid-readings.test.ts — content-version changes fence a warm worker | assertion kill |
| Paid / `paid-uncertain-replay` | tests/paid-readings.test.ts — committed uncertain slot is never replayed | assertion kill |
| Paid / `paid-actual-spend-not-clamped` | tests/paid-readings.test.ts — measured error spend produces | assertion kill |
| Paid / `paid-atomic-checkpoint` | tests/paid-readings.test.ts — settled checkpoint survives crash | assertion kill |
| Paid / `paid-zero-cost-consumed-allowance` | tests/paid-readings.test.ts — ledger validates model receipts | assertion kill |
| Paid / `paid-snapshot-hash` | tests/paid-readings.test.ts — mismatching hash | assertion kill |
| Paid / `paid-snapshot-facts` | tests/paid-readings.test.ts — snapshot contradictions are rejected | assertion kill |
| Paid / `paid-manifest-completeness` | tests/paid-readings.test.ts — paid completeness is the frozen | assertion kill |
| Paid / `paid-get-never-reaps` | tests/paid-readings.test.ts — GET never performs recovery | assertion kill |
| Paid / `annual-selected-year-age` | tests/annual-facts.test.ts | assertion kill |
| Paid / `annual-traditional-scorpio-ruler` | tests/annual-facts.test.ts | assertion kill |
| Paid / `annual-transit-motion` | tests/annual-facts.test.ts | assertion kill |
| Paid / `annual-birth-not-return-place` | tests/annual-facts.test.ts | assertion kill |
| Paid / `annual-consent-payload-version` | tests/annual-facts.test.ts | assertion kill |
| Paid / `editorial-reject-synthetic` | tests/paid-evaluation.test.ts — paid corpus: | assertion kill |
| Paid / `editorial-exact-version` | tests/paid-evaluation.test.ts — exact-profile/config/locale | assertion kill |
| Paid / `editorial-receipt-arithmetic` | tests/paid-evaluation.test.ts — editorial receipts: | assertion kill |
| Paid / `checkout-final-chart-fence` | tests/checkout-context.test.ts | assertion kill |
| Paid / `paid-streamed-body-limit` | tests/control-json.test.ts | assertion kill |
