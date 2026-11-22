# Review handoff — S1-d, factual wheel in the PDF (PR #161)

Written 2026-11-20 for the next reviewer. The gate table in §3 was measured on **`d3ddb08`**;
nothing is quoted from an earlier round or from the PR description. The header SHA is
intentionally not repeated per-round — every revision of this document lags its own commit by
construction, so the SHA that matters is the one on the PR.

- **PR:** [#161](https://github.com/jtanori/solara/pull/161) → `staging`
- **Base:** `9de566d` (`origin/staging`); the head is whatever the PR shows
- **Size:** 10 commits, 17 files, +2616 / −74 at `d3ddb08`, before this document's own
  commit. Run `git diff --stat origin/staging...HEAD` for the current figure rather than
  trusting this line; it goes stale on every revision.
- **Labels:** `type:feature`, `deploy:required`
- **State:** `MERGEABLE` / `BLOCKED` — blocked by **unresolved conversations**, not by a
  missing approval. `protect-staging` requires conversation resolution and **zero** approving
  reviews; this repository reviews COMMENT-only and records a SHA-pinned verdict. Nothing
  merged, deployed or promoted.

## 1. What to review, in priority order

The slice is small; the *tests* are most of it (`tests/readings-wheel-pdf.test.ts` is 1124 of
the 1980 added lines). Spend the time there. Four rounds of review, plus one self-review, have found six defects in
this PR's tests. Five of those six were test-side — assertions that could not fail — but the
sixth was **not**: an early revision drew the wheel's text in a face that lacked the glyphs,
so the labels were missing from real output while the tests, which compared the document's
text items to the projection, still passed. That one was a confirmed rendering defect the
tests failed to catch, and it is the reason the glyph assertions now inspect the emitted font
resources rather than the input string list.

| Order | Area | Why first |
| --- | --- | --- |
| 1 | `tests/readings-wheel-pdf.test.ts` — every assertion's *expectation* | Four of the six defects found so far were assertions whose expected value came from the same code as the actual value. §4 lists the pattern and the mutations that now catch it |
| 2 | `src/components/pdf-chart-wheel.tsx` | The emitter. Check that every label sets `fontFamily: PDF_FONT`, and that no geometry is recomputed |
| 3 | `scripts/build-pdf.mjs` | Rewritten in this PR to serialise concurrent builds. Not part of the feature, but it is the reason `verify` failed three times; see §5 |
| 4 | `src/readings/wheel-labels.ts` | The single source of wheel copy, shared by page and PDF |
| 5 | `src/components/solar-pdf.tsx` | Composition: `wheelCopy`, glyph gate, the unbreakable block |
| 6 | `docs/plan-solar-wheel-facts.md` | S1-d section: acceptance, mutation table, both "absent wheel" reversals |

## 2. The contract this slice implements

One projection, two emitters. `src/lib/wheel.ts` (`projectWheel`) produces `WheelGeometry`;
`src/components/chart-wheel.tsx` renders it into page `<svg>` and
`src/components/pdf-chart-wheel.tsx` into PDF `<Svg>`. **Neither emitter may compute a
position.** If you find an angle, radius or collision decision in either component, that is a
finding — the projection is the whole point of S1-b.

Two consequences worth checking directly:

- Every string the wheel contributes must reach `pdfGlyphsSupported` **before** rendering.
  `pdfStrings` and the layout both derive from one `wheelCopy({ chart, content, geometry,
  hasFacts })` object, so a copy change cannot reach one without the other.
- The drawing cannot paginate (`Svg` is in `@react-pdf/layout`'s `NON_WRAP_TYPES`), but the
  heading, title and caption are `Text` siblings and **can** separate from it. The guarantee
  is `wrap={false}` on the enclosing `View` in `solar-pdf.tsx`. Removing it fails the
  title/caption co-location test.

## 3. Measured state at `d3ddb08`

| Gate | Result |
| --- | --- |
| `npx tsx --test tests/*.test.ts` (`RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1`) | **842 / 842**, 0 fail, 0 skipped — PostgreSQL 16.2 on loopback, migrations applied |
| `tests/readings-wheel-pdf.test.ts` | **26 / 26** in ~76 s |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests scripts --max-warnings=0` | clean |
| `npm run build` | succeeds |
| `node scripts/check-pdf-package.mjs` | **220 files, 5.9 MiB** — identical to `staging` |
| GitHub `verify` / `pr-lint` | pass / pass (5m2s / 5s on `d3ddb08`) |
| Mutations run | 16 feature + 6 worker-build (§5a), the last of which is not test-covered and says so |

Snapshots: `tests/fixtures/readings/pdf-snapshots.json` changes by **8 text lines and 8
hashes** (4 EN + 4 ES), all of them the absent-wheel sentence. Regenerated intentionally and
reviewed as rasters in both locales.

## 4. The defect pattern this PR kept producing

Record this, because it is the most useful thing in this handoff. Four separate review rounds
found the same shape of mistake, and each was **an assertion that could not fail**:

> The expected value was taken from the same shared projection the code under test reads,
> rather than from the other rendered surface.

Concretely, in the order they were found:

1. The PDF label test read its "page" labels from `wheelLabelTexts(geometry)` — the PDF's own
   function. An HTML-only label change passed.
2. The PDF side then used `includes()` over the whole extracted document, so an extra label
   painted only by the PDF passed.
3. The paid test searched `projectWheel(snapshot.facts)` for anchors instead of reading the
   emitted tree, so shifting every Placidus anchor by +18 on x passed.
4. The region helper asserted a **single constant y offset**; the real mapping is affine in
   the font size (`dy = 130.24 + 0.357 × size`, worst residual 0.0004pt). It passed only
   because the fixture's labels span 7–10pt.
5. The absence block had only one sentence to assert, so *any* sentence satisfied it; the two
   states (positions missing vs. horizon withheld at high latitude) needed two notices before
   the test could distinguish them.
6. Page identification by "more than half the labels present" matched **three** pages on a
   paid edition — the drawing plus two aspect tables listing body names as rows.

The rule that came out of it, and the one to review against:

- Text: extract the PDF's items by **measured page coordinates**, compare the sorted multiset
  to the page's rendered `<text>` nodes. Both directions (extra *and* missing).
- Geometry: walk the emitted element tree; never re-search the projection.
- Metadata and prose: compare field by field, excise only the wheel region.

### Mutations, all 16 verified to fail

| Mutation | Killed by |
| --- | --- |
| wheel labels omitted from the glyph set | glyph-set test |
| surrounding wheel copy omitted from the glyph set | glyph-set test |
| one-sided change to the input bound | parent/child bound test |
| payload de-normalised (facts serialized twice) | single-copy payload test |
| locally recomputed chord angle | coordinate-parity test |
| only a chord's second endpoint moved | coordinate-parity test |
| anchor primitives removed | coordinate-parity test |
| `wheelFacts` dropped from the serialized input | wheel-present + paid tests |
| `fontFamily` removed from the SVG text nodes (sign, house or point; any weight) | embedded BaseFont set = exactly the gated Noto faces |
| `wrap={false}` removed from the enclosing `View` | title/caption co-location test |
| only the page's Pluto label changed | rendered-page parity test |
| `wheelAbsentReason` collapsed to one code | two-reasons test (EN + ES) |
| an extra label painted in the PDF's SVG only | PDF-region vs rendered-page multiset |
| every Placidus anchor shifted +18 on x | paid edition vs the snapshot's projection |
| the whole PDF drawing scaled 1.02× | x-translation + baseline-slope assertions |
| only labels at one type size displaced | baseline slope, not a constant offset |

## 5. The build-script change — read this before flagging it

`scripts/build-pdf.mjs` is in this PR for a reason that is not the feature, and a reviewer
should know it was necessary rather than convenient.

`node --test` runs each file in its own process. Four suites call this script in `before()`
(`pdf`, `paid-presentation`, `paid-readings`, `readings-wheel-pdf`) — the fourth is this PR's.
esbuild opens its outfile and streams into it, so the destination was partial JavaScript for
the duration of every write, and a worker forked by another suite in that window started from
truncated source. That is why `verify` failed three times while five local full runs passed:
the runner has 4 cores and the development sandbox has 2.

Two related defects surfaced while fixing it, one of them introduced by the first attempt:

- Concurrent `cp(..., { recursive: true })` of `standard-fonts` crashed builders with
  `ENOENT ... HelveticaBold.mjs` (create → copy → chmod, racing).
- The first fix (atomic renames) left esbuild's `.LEGAL.txt` sidecar accumulating — 47 files
  inside the shipped package, and the deployment trace went **220 → 266 files**.

The fix is a lock file serialising a ~1s build, acquired with `link` (atomic **and** `EEXIST`
when held) and reclaimed only when its owner is **proven dead** by `kill(pid, 0)`, with
reclaim and release done by rename-to-quarantine. §5a has the mechanism and the five mutations
that pin it; do not rely on this paragraph for the details, it is a summary of a script that has
been rewritten three times. The current behaviour: eight concurrent builders hold across
repeated rounds, and the lock is never evicted from a live holder regardless of its mtime.

**Review it as infrastructure, not as feature code.** If you would rather the four suites shared
one build (a global setup) instead of serialising, that is a bigger change and belongs in its
own PR; this one keeps the blast radius small.

## 5a. Late review round: three worker-build blockers

The build script was reviewed separately from the feature and came back with three P1
findings, all reproduced independently. All three were mine, introduced in `4cc8585`:

| Finding | Cause | Fix |
| --- | --- | --- |
| The bundle's license footer named a deleted file | esbuild derives `For license information please see <outfile>.LEGAL.txt` from the outfile it is *given*; building to `worker.mjs.<pid>.tmp` and renaming shipped a footer naming a file that no longer existed | Build under the **final basename** in staging, so the footer is correct as emitted; `check-pdf-package.mjs` now extracts the footer's named file and asserts it exists *and* is traced |
| The writer lock did not protect readers | `package.json` was truncated and rewritten in place; assets were `cp`ed over live names. A reader forked in that window died with `ERR_INVALID_PACKAGE_CONFIG` — reproduced, then fixed | Nothing is written at a reader-resolvable path. The package is built in `.venv/pdf-build/` and published by per-file `rename` (atomic, overwrites), bundle last |
| A stale-lock check could evict a live builder | Reclamation was by mtime age; a 60s-old lock belonging to a live builder was deleted mid-publish | Reclaim only when the owner is **proven dead** (`kill(pid, 0)`), re-verifying pid *and* inode before unlinking; release only a lock we still own |

Found while fixing the third, and worth recording because it shows the previous "serialisation"
was not serialising at all: the acquire path wrote a pid to a private file and `rename`d it onto
the lock. `rename` **overwrites**, so a second builder silently took the lock from the first —
the exact eviction the finding describes, in a form no lock-age argument would explain. `link`
is the correct primitive: atomic *and* `EEXIST` when the target exists. Five mutations, each
killed by exactly one named test:

| Mutation | Killed by |
| --- | --- |
| build to a temporary basename and rename it | the license-footer test |
| write `package.json` in place before publishing | the paused-publication reader test |
| reclaim the lock by mtime age | the live-holder test |
| never reclaim a dead owner's lock | the dead-owner test (and the concurrent-build test) |
| `link` → `rename` when taking the lock | the live-holder test |
| `fontFamily` removed from a **regular-weight** sign or house node | embedded-BaseFont-set test (the two earlier font tests both passed this) |
| `publish()` writes `package.json` in place | the forked-worker publication test |
| check-then-unlink reclaim (the quarantine `rename` replaced by an `rm`) | **not covered by a test** — the window is sub-millisecond; the primitive was verified separately, see below |

### What the quarantine reclaim is and is not

The reclaim and release were `rm`-by-name after a pid+inode check, which two contenders can both
pass: the first unlinks and `link`s a successor, and the second's already-decided `rm` deletes the
**successor's live lock**. They now `rename` the lock to a name only that process can create, so
exactly one contender can move it, and the winner inspects what it moved before discarding it.

That is an argument about a primitive, and it is honestly not pinned by a deterministic test: a
mutation that restores check-then-unlink still passes the whole suite, because the window is
microseconds. What was verified separately: 60 rounds × 8 concurrent claimants of one lock
produced **exactly one winner every round**, and a foreign lock that was moved is `link`ed back
rather than dropped. If a future change needs stronger evidence, the honest options are a
`flock`-style kernel lock or injecting a delay hook into the reclaim path — not a timing-based
test that would fail only occasionally.

## 6. Traps that cost time here

1. **`.pdf/` must be rebuilt before any render probe.** `ReadingPdfRenderer` renders through
   the prebuilt `.pdf/worker.mjs`, not through `src/`. A probe without
   `node scripts/build-pdf.mjs` inspects a stale bundle and reports conclusions about code
   that is not running.
2. **Recomputing an anchor from `point.angle` drifts at 3 dp.** The projection computes
   anchors from the *unrounded* angle. Use `point.anchor`; recomputation produces false
   failures on the nodes.
3. **`pdfFixture(locale, "paid")` is a free-tier-shaped document** — whole-sign summary, no
   `chart.calculation`. Pairing it with fresh Placidus facts produces a document that
   contradicts itself. The paid tests build what `loadPaidPresentation` builds:
   `calculatePaidSnapshot` + `paidCalculationBlocks`.
4. **A paid edition's aspect tables contain body names as rows.** Any "find the drawing's
   page" heuristic based on label presence will match them. House numbers are the only
   discriminator.
5. **`Sun` is both a summary row and a wheel label.** Label-absence assertions must use
   drawing-only text (truncated labels ≥10 chars, house numbers).
6. **`generatedAt` is fixed at `2026-01-01T12:00:00.000Z`** in fixtures; page counts are
   stable, so `9 → 10` for the paid document and `4 → 5` for the free one are expected.
7. **Do not edit the tree while the suite runs.** Two mass-failure captures in this repo were
   self-inflicted.

## 7. What was deliberately not verified

State these honestly rather than inheriting them as passed:

- **No hosted or staging QA.** The raster review was local, 96 dpi, both locales. Per the
  operator's sequencing, staging QA, the back-merge and promotion are deferred until the
  operator is satisfied with the branch. `docs/operations/staging-qa-solar-wheel-s1c.md`
  is the checklist for that stage and has not been run for this slice.
- **No deployment.** `deploy:required` is set; nothing was dispatched.
- **No browser-level check** of the PDF's download path in a hosted environment.
- **No independent re-measurement of the 220-file trace** beyond `scripts/check-pdf-package.mjs`
  on this branch and on `staging`.
- The absent-wheel copy was reviewed as a raster in both locales, but the *high-latitude*
  absence reason was only asserted as extracted text, not rendered to an image.

## 8. State of the review threads

Everything below is a list rather than a count, because the counts move every time the reviewer
resolves a thread and an earlier version of this section contradicted itself twice for exactly
that reason. The numbers here were measured on `d3ddb08` via `reviewThreads`: **20 total, 15
resolved, 5 open.** Re-read them there; do not trust this paragraph's arithmetic.

Open, and what each one is waiting on:

- three worker-build P1s (license footer, reader-visible partial package, live-lock eviction) —
  fixed in `d154b63`, awaiting the reviewer's resolution rather than further code
- the merge-requirement correction to this document — superseded by this section
- the finding-7 thread, which stayed open over precisely the count that used to be here

Resolved: the font-gate blocker, the published-manifest check, the 60 s reader-test Low, the
page/PDF label parity, the paid-Placidus geometry, and the earlier test-quality findings.

Per the earlier correction: `staging` requires **conversation
resolution** and **zero** approving reviews — a formal approving review is not part of the
branch policy here. The prior threads were actionable findings, not a missing approval, and
"awaiting approval" is the wrong explanation for a `BLOCKED` state in this repository.

## 9. Authority

The operator is the sole merge, deploy and promotion authority. This handoff authorises no
merge, no deployment, no workflow dispatch and no migration. Per the operator's 2026-11-19
sequencing, staging QA, the back-merge PR and promotion wait until the operator says the
branch is ready.
