# Dependency security remediation

This work follows the operator's request to fix **all** reported dependency
audit findings, not only the production-scoped audit. It is on the existing
`arena/d350cb2e-solara` branch; no force-fix downgrade, advisory exclusion or
workflow/audit-threshold change is used. Generation remains disabled.

## Baseline and repair

The unrestricted baseline at `f4a5c8c90f2653b8784772f36a2c89a368ebb90a` reported
**19 entries: 9 high / 10 moderate / 0 critical**. The production audit reported
**0**. All affected dependency paths were dev-only. These are dependency-chain
entries arising from three advisories, not 19 separate application defects.

| Advisory | Repair |
| --- | --- |
| [Minimatch expansion DoS — GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | `eslint-config-next` 16.2.6 → 16.4.6; TypeScript ESLint 8.72.1 → 8.73.0 resolves its Minimatch 10.2.6 → **11.0.9** (patched floor 11.0.1). |
| [esbuild dev-server CORS — GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | `drizzle-kit` 0.31.10 → 0.31.11, plus an exact override **only under `@esbuild-kit/core-utils`** from esbuild 0.18.20 to **0.25.12**. Upgrading Kit alone leaves the vulnerable legacy loader. Its sync/async transform APIs and server CORS are tested. Root esbuild 0.28.2 is unchanged. |
| [Picomatch repeated-extglob DoS — GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) | There is no published patched release; latest 4.0.7 is affected. Use the private source-pinned **4.0.7-solara.2** backport with an explicit conservative parser restriction, installed via an integrity-pinned local npm archive. All consumers use the patched v4; Micromatch's former v2 dependency is deliberately upgraded and checked for compatibility. |

The published-update commit is `921250d`. The private backport's full policy,
license, provenance, archive reproduction and eventual removal procedure are in
[`vendor/README.md`](../vendor/README.md). **The zero audit count alone does not
validate a private fork**: its exact source/installed/archive bytes, regression
behavior and real consumers are checked separately. No claim is made that
arbitrary Picomatch patterns are unchanged or that every possible regex DoS is
solved. Repeated extglobs containing a star, including escaped/quoted/class
stars, deliberately become literals; ordinary matching remains supported.

## Evidence so far

- Fresh unrestricted audit after remediation: **0 vulnerabilities**.
- Ordinary `npm ci` with Node **22.22.3** / npm **10.9.8**: **491 packages
  installed, 492 audited, 0 vulnerabilities**. No special npm configuration,
  postinstall patch, registry publication, or workspace-specific path required.
- All **10** new dependency-security tests pass following that clean install.
- `npm ls --all --json`: exit 0; no missing/invalid/extraneous dependency nodes.
- Differential compatibility check: **81,180 comparisons**, 451 tracked or
  synthetic paths × 15 ordinary patterns × 6 option sets × both previous
  upstream versions (2.3.2 and 4.0.7); **0 mismatches** with the backport. This
  deliberately excludes the newly restricted repeated-star syntax and is not
  an exhaustive glob-language equivalence claim.
- Focused ESLint on the security tests, deployment test and ESLint config: pass.

Full gates, deliberate mutation results and final revision binding are recorded
below after they execute. Historical paid-reading results remain at their
original SHA in [the paid verification record](paid-reading-verification.md);
they are not silently attributed to changed dependencies.

## Safety boundaries

Only dev dependencies and their resolution are changed. Production dependency
versions, application/worker code, existing migrations and PDF assets remain
unchanged. The vendored npm archive is retained in deployment input because
preview/CI installation needs it, but it must not enter the PDF runtime trace.
The upstream CommonJS source is excluded from project-style linting; its exact
upstream delta and installed/archive integrity are explicitly tested instead.
No application lint rule, CI workflow or audit scope is weakened.

Checks use a disposable loopback database, synthetic accounts and fake provider
transport only. No real provider, genuine editorial approval, hosted executor,
Stripe purchase, hosted migration, deployment, merge or promotion is authorized
by these results. Email remains deferred. The paid/free generation flags and
shared paid database control remain off.
