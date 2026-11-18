# Dependency security remediation

## Evidence boundary

**Validated code/test revision: `c236718cf9768cf7ec1531b1f22c5e6da6843f18`.**
Branch: `arena/d350cb2e-solara`; fetched staging and merge-base:
`e79671a6658b82a1867afdb30cbcaae4b6481bed`. This record is finalized afterward;
subsequent documentation-only edits do not change the tested tree.

The operator requested fixes for **all** dependency audit findings, not only the
production audit. No force-fix downgrade, advisory exclusion, audit-threshold
change or CI workflow change is used. Generation remains disabled. The prior
audit-related PR hold is resolved; review, CI and deployment gates are separate.

## Baseline and repair

The unrestricted baseline at `f4a5c8c90f2653b8784772f36a2c89a368ebb90a` reported
**19 entries: 9 high / 10 moderate / 0 critical**. The production audit reported
**0**. All affected dependency paths were dev-only. These are dependency-chain
entries arising from three advisories, not 19 separate application defects.

| Advisory | Repair |
| --- | --- |
| [Minimatch expansion DoS — GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | `eslint-config-next` 16.2.6 → 16.4.6; TypeScript ESLint 8.72.1 → 8.73.0 resolves its Minimatch 10.2.6 → **11.0.9** (patched floor 11.0.1). |
| [esbuild dev-server CORS — GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | `drizzle-kit` 0.31.10 → 0.31.11, plus an exact override **only under `@esbuild-kit/core-utils`** from esbuild 0.18.20 to **0.25.12**. Upgrading Kit alone leaves the vulnerable legacy loader. Its sync/async transform APIs and server CORS are tested. Root esbuild 0.28.2 is unchanged. |
| [Picomatch repeated-extglob DoS — GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) | No published patched release exists at remediation time; latest 4.0.7 is affected. Use the private source-pinned **4.0.7-solara.2** backport with an explicit conservative parser restriction, installed via an integrity-pinned local npm archive. All consumers use the patched v4; Micromatch's former v2 dependency is deliberately upgraded and checked for compatibility. |

Commits: `921250d` (published dependency fixes), `048cec9` (backport and tests),
`c236718` (ES2017-compatible archive test). The initial typecheck caught two
ES2018-only regex flags in the new test helper; they were replaced with bounded
NUL splitting before the final mutation/full-validation sequence below.

The private backport's policy, license, provenance, archive reproduction and
removal procedure are in [`vendor/README.md`](../vendor/README.md).
**The zero audit count alone does not validate a private fork**: its exact
source/installed/archive bytes, regression behavior and real consumers are
checked separately. The private name alone is not a fix, and npm's registry
advisory database does not independently review this code. Monitor upstream
and retire the backport when a verified patched release is available.

No claim is made that arbitrary Picomatch patterns are unchanged or that every
possible regex DoS is solved. Repeated extglobs containing a star, including
escaped/quoted/class stars, deliberately become literals. Exact escaping is
necessary: the upstream helper preserves some already-escaped syntax and was
not suitable as a literal encoder. A regression test and mutation cover this.
Mixed local-directory overrides were rejected because npm could retain/coalesce
the wrong version; the final direct archive dependency/global reference works
with ordinary `npm ci`, and actual consumer resolution is asserted.

## Final executed results

Environment: Node **22.22.3**, npm **10.9.8**, PostgreSQL **16.2**, disposable
loopback port 5438, Chromium **153.0.8010.0**. Dotenv loading disabled; no real
local env files loaded. Integration tests use synthetic accounts/fake transport.

| Check | Observed result |
| --- | --- |
| `npm ci` | **491 installed / 492 audited / 0 vulnerabilities**; no special npm config, install hook or workspace path |
| `npm ls --all --json` | exit 0; no missing/invalid/extraneous dependencies |
| `npm audit --include=dev --json` | **0 vulnerabilities**, exit 0 |
| `npm audit --omit=dev --json` | **0 vulnerabilities**, exit 0 |
| Source/installed/archive and security tests | **10/10** pass after clean install and again after mutations |
| Dependency mutations | **9/9 assertion kills**; all files/directories restored; restored suite passes |
| `npx next typegen` | pass |
| `npm run typecheck` | pass |
| `npm run lint` | pass, full configured project scope |
| Full suite with both integration flags | **717 passed / 0 failed / 0 skipped**, 417279.924202 ms |
| `npm run build` | pass, Next **16.4.5** production build and TypeScript |
| `npm run db:manifest:check` | current |
| `npm run db:check` | **24 tables / 147 columns / 22 indexes**; no pending/unexpected migrations |
| Disabled `npm run readings:worker -- --once` | exit 0 |
| `node scripts/check-pdf-package.mjs` | **218 files / 5.9 MiB**; required worker/assets present, local test tools absent |
| `npx tsx scripts/verify-reading-browser.ts` | **22 cases**; **0 provider fetches / 0 automatic POST/PUT**, saved editions and ledgers preserved |
| Post-browser shared paid control / approvals | **false / 0 rows** |
| `git diff --check` | pass; generated `next-env.d.ts` churn restored, not committed |

The differential compatibility check ran **81,180 comparisons**: 451 tracked
or synthetic paths × 15 ordinary patterns × 6 option sets × both former upstream
versions (2.3.2 and 4.0.7), with **0 mismatches**. It excludes the newly restricted
repeated-star syntax and is not exhaustive language-equivalence proof. The
committed tests additionally check real Fast-glob and sync/async Tinyglobby file
discovery, hidden-file exclusion, ignore patterns and positive/negative matches.
Hostile regex cases run with a **64 MiB V8 old-space limit and 5-second external
wall deadline**; this is not an OS/RSS guarantee. Independently, the original
2.3.2 and 4.0.7 parsers both exceeded a one-second deadline on
`makeRe('+(*a)').test('a'.repeat(48) + '!')` and were killed externally. Those
bounded reproductions establish the original hang; they are **not** counted as
assertion kills in the mutation table.

All production lock entries were independently compared as complete parsed
objects with `f4a5c8c` and are **identical**, including versions, resolutions and
integrities. Application/worker sources, existing migrations, PDF assets and
root build esbuild are unchanged. Incidental unrelated dependency drift from
resolution experiments was restored through npm, not hand-edited lock entries.

### Mutation evidence at the validated revision

Run the committed runner from a clean checkpoint:
`DOTENV_CONFIG_PATH=/dev/null node scripts/verify-dependency-mutations.mjs`.
It installs old versions only in an ignored, isolated negative-control project,
disables install scripts there, temporarily substitutes actual installed code,
and restores after **each** mutation. Original tarball/source bytes are checked
on restoration. Syntax/import/timeout/native-binary mismatch failures are not
accepted as kills. The final full suite/build/browser run followed restoration.

| Mutation | Failing guard | Result |
| --- | --- | --- |
| Remove repeated-star guard, restoring upstream parser behavior | `dependency-security.test.ts`: Micromatch consumer must reject wildcard repetition on a short matching input | assertion kill |
| Protect `+` but not `*` repeated extglobs | Same consumer behavior test: `*(*a)` | assertion kill |
| Re-enable recursion-option bypass | Same test with `maxExtglobRecursion: false` | assertion kill |
| Use incomplete upstream literal escaping | Compiled-regex literal round trip for escaped star | assertion kill |
| Disable all matching instead of fixing the dangerous form | Ordinary matching and real filesystem caller test | assertion kill |
| Corrupt local npm archive bytes | Archive SHA-512/source equality guard | assertion kill |
| Restore real Minimatch **10.2.6** | Expected bounded `**/..` expansion rejection is absent | assertion kill |
| Restore real esbuild **0.18.20**, including its matching native binary | Actual served source returns wildcard CORS for a foreign origin | assertion kill |
| Exclude the archive from deployment input | `deployment-inputs.test.ts`: required install archive missing | assertion kill |

The earlier **85** paid/presentation mutation results remain explicitly pinned
to `7d5549c` in [the paid verification record](paid-reading-verification.md).
They were **not rerun** for this dev-tool-only cleanup: their runtime guards,
tests, renderer/build compiler and complete production dependency graph are
unchanged. The full **717-test** suite and **22-case** production-mode browser
check *were* rerun after the cleanup. The older resource benchmark and genuine
provider/editorial/hosted qualification are not claimed as new evidence.

## Reproduction commands

Standing `full-validation=authorize` covered local checks and fixes/reruns;
expensive commands and their purposes were announced. From a clean committed
checkout with a separately provisioned disposable PostgreSQL database:

```bash
export DOTENV_CONFIG_PATH=/dev/null
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5438/paid_readings
export APP_URL=http://localhost:3000
export NEXT_TELEMETRY_DISABLED=1
export READINGS_GENERATION_ENABLED=false
export READINGS_PAID_GENERATION_ENABLED=false

npm ci
node scripts/verify-dependency-mutations.mjs
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

The full suite includes disposable-database migrations using the updated Kit,
as well as upgrade/immutability/seed/index/FK checks for the paid migrations.
No hosted database or customer data is needed. Logs and negative controls remain
ignored; this committed report and runner are the durable, portable evidence.

## Self-review, scope and remaining boundaries

- Reviewed the manifests/lock changes, sole upstream parser delta and metadata,
  archive contents, tests, mutation runner, lint/deployment rules and docs. The
  inherited paid implementation's earlier self-review remains separately bound;
  author self-review is not an independent reviewer verdict.
- The large diff includes readable upstream source and its **16,836-byte** npm
  archive so installations are reproducible and reviewable, not opaque patched
  binaries. The only upstream source change is the documented parser block.
- The archive stays in deployment input because CI/preview installation needs
  it; the mutation test enforces this. It does not enter the PDF runtime trace.
  Only vendored CommonJS is excluded from project-style linting; exact source
  provenance and behavior are tested. No application lint rule is weakened.
- Staging was fetched again after validation and still matched the merge-base.
  Dependency PRs **#26–#35** overlap package files; **#27/#29** contain the exact
  Kit/Next-ESLint bumps now included here. Record coordination and the intended
  merge order on the PR; do not alter/close/merge those branches as part of this
  work. No separate identity or independent-approver gate is introduced.
- No real provider call, genuine editorial approval, hosted executor, Stripe
  purchase, hosted migration/deployment, merge or promotion was performed.
  Email remains deferred. The generation flags and shared paid control stay off.
  All previously documented activation and purchase-acceptance gates remain.
