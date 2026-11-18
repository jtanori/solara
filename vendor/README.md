# Temporary, private dependency security backport

## Why Picomatch is here

At remediation time, `picomatch@4.0.7` is the latest published release and
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
(CVE-2026-112366) has **no published patched version**. Updating to latest,
ignoring the advisory, or renaming unchanged vulnerable code would not fix it.
The affected repeated extglobs include `+(*)`, `+(*a)` and `*(*a)`: a generated
unbounded wildcard inside another repetition can block the event loop.

`picomatch-v4/` is an explicit **private Solara fork**, not an upstream release.
It keeps Picomatch 4.0.7's MIT license, author and public API. The package name
is `@solara/picomatch-v4`, the local version is `4.0.7-solara.3`, and publication
is disabled with `private: true`. It adds no dependency or install script.

`picomatch-provenance.json` records the original npm archive URL/integrity,
upstream commit, every original/source file hash, and the local archive
integrity. Apart from package metadata, **the only upstream source edit is the
small, commented guard in `lib/parse.js`**. No unmerged upstream PR or
third-party npm fork is trusted as the fix.

## Deliberately conservative compatibility policy

The previous `.2` star-only restriction was **insufficient**: review reproduced
`+([ab]+)` compiling a nested unbounded quantifier and hanging on 35 `a`s plus
`!`, despite a zero audit count. `.3` replaces that blacklist with an allowlist.

When the parser closes a **repeated** extglob (`+(...)` or `*(...)`), it permits
only **1–16 nonempty ASCII words** (`[A-Za-z0-9_-]+`), separated by `|`, whose
first characters are all distinct after ASCII case folding. Each iteration then
has exactly one possible branch and consumes a fixed nonempty word. Case is
folded even without `nocase`, because `flags: 'i'` can override that option.

**Every other repeated body becomes a fully escaped literal**, not another
interpreted expression: stars, classes, nested groups, regex plus, optional
syntax, escaped/quoted syntax, empty/overlapping branches, and excess branches.
Examples: `+(*a)`, `+([ab]+)`, `+(a?(b))`, `+(foo|foobar)` and `+(a|A)` now match
only their literal spelling under the selected case options. This intentionally
restricts some safe patterns too; it does not attempt to reparse or simplify
arbitrary glob/regex syntax. `maxExtglobRecursion: false` and regex options cannot
relax the recognized repeated-extglob guard.

Ordinary `**/*.ts`, braces, brackets, dot/Windows/case options, deterministic
literal repeats such as `+(foo|bar)`, and non-repeating/negated extglobs retain
their existing behavior. The bounded tests exercise matcher, `makeRe` and
`parse`/`compileRe`, all real installed consumers, and class/group/plus/optional/
alternation cases. Parser syntax that is not recognized as a repeated extglob
(e.g. raw lookaround-like `(?...)` groups), arbitrary regex options/prepended
regex, combinations of independent unbounded patterns, and caller-supplied
`compileRe` states are **not** a general linear-time regex guarantee. Do not
expose this regex-based tool to arbitrary untrusted regexes without a separate
process deadline. The local threat model remains dev-tool glob inputs, not a
demonstrated browser-request exploit.

All transitive callers use this one pinned implementation through the direct
dev dependency `picomatch` and `overrides.picomatch: "$picomatch"`.
**Micromatch's former Picomatch 2 dependency is intentionally upgraded to this
patched version 4**, rather than mixing two locally overridden majors. The
resolver's directory overrides could silently retain an old package or
coalesce the two majors; they are not used. Tests check actual consumer
resolution, not just the manifest. Tinyglobby/Fdir already used version 4.
No runtime application dependency is added or changed.

## Installation and evidence

The small checked-in `solara-picomatch-v4-4.0.7-solara.3.tgz` is required by npm's
pinned `file:` dependency and its lockfile integrity. It is produced with
`npm pack ./vendor/picomatch-v4 --ignore-scripts --pack-destination vendor`.
It is intentionally retained alongside readable source: **no build-time
network fetch, postinstall patch, absolute workspace path or symlink override**
is needed. The archive must remain in deployment input so ordinary `npm ci`
works in CI and previews. It is dev-only, not part of the PDF runtime trace.

`tests/dependency-security.test.ts` runs in the normal test suite and verifies:

- Every installed Picomatch caller resolves the actual backport; no original
  registry copy remains in the lockfile; patched tool dependencies stay dev-only.
- Upstream/source/installed file hashes, the sole source delta, archive
  integrity, and **each archive member's exact correspondence to readable source**.
- Dangerous patterns become literals through the matcher, `makeRe`, and
  `parse`/`compileRe`; capture and the former recursion opt-out do not bypass it.
- Hostile long-input cases run in a separate process with a 64 MiB V8 old-space
  limit and five-second external wall deadline (not an OS/RSS guarantee); a hung
  regex cannot hang the whole suite.
- Positive/negative ordinary matches plus real Fast-glob and synchronous/
  asynchronous Tinyglobby filesystem discovery retain their expected behavior.
- The separately updated Minimatch bounds `**/..` expansion, and the updated
  nested esbuild preserves loader transforms without permissive server CORS.

**Audit limitation:** npm's advisory database does not independently review
private forks. A zero audit count is therefore accompanied by source,
behavioral, mutation and clean-install evidence; the private name alone is not
the remediation. See [the current review-remediation record](../docs/pr151-review-remediation.md)
for the `.3` runs and [the historical first pass](../docs/dependency-remediation.md)
for the superseded `.2` evidence. Upstream replacement is tracked in
[#150](https://github.com/jtanori/solara/issues/150).

## Maintenance and removal

Monitor the linked upstream advisory/releases. Remove this fork once a
published fixed release is available and its behavior passes the regression
and consumer tests. Use npm to update the affected parent dependencies/lockfile;
remove the direct file dependency, override, archive and vendored source
*together*, and adapt the provenance-specific assertions without dropping the
security/compatibility tests. Re-run both audits, a clean install, typegen,
typecheck, lint, the full integration suite and build. Do not mark an upstream
version safe merely because its number is higher.

For any local backport change: bump the private version, review the source
patch, repack with npm, update the provenance hashes and direct archive spec,
and let npm regenerate the lockfile. The source/archive equality test must pass.
Do not edit a shipped tarball invisibly or remove the guard tests to obtain a
clean audit. Run all release gates before deploying; generation remains off.
