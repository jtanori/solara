# Review handoff — S1-d, factual wheel in the PDF (PR #161)

Written 2026-11-20 for the next reviewer. Everything below was measured on `4cc8585`; nothing
is quoted from an earlier round or from the PR description.

- **PR:** [#161](https://github.com/jtanori/solara/pull/161) → `staging`
- **Head:** `4cc8585` · **Base:** `9de566d` (`origin/staging`)
- **Size:** 7 commits, 15 files, +1980 / −68
- **Labels:** `type:feature`, `deploy:required`
- **State:** `MERGEABLE` / `BLOCKED` — two review threads open, no approving review. Nothing
  merged, deployed or promoted.

## 1. What to review, in priority order

The slice is small; the *tests* are most of it (`tests/readings-wheel-pdf.test.ts` is 1124 of
the 1980 added lines). Spend the time there. Four rounds of review, plus one self-review, have found six defects in
this PR's tests and none in the drawing itself, so a test that cannot fail is the dominant
risk, not a wrong pixel.

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

## 3. Measured state at `4cc8585`

| Gate | Result |
| --- | --- |
| `npx tsx --test tests/*.test.ts` (`RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1`) | **837 / 837**, 0 fail, 0 skipped — two consecutive full runs, PostgreSQL 17 on loopback |
| `tests/readings-wheel-pdf.test.ts` | **21 / 21** |
| `npx tsc --noEmit` | clean |
| `npx eslint src tests scripts --max-warnings=0` | clean |
| `npm run build` | succeeds |
| `node scripts/check-pdf-package.mjs` | **220 files, 5.9 MiB** — identical to `staging` |
| GitHub `verify` / `pr-lint` | pass / pass (4m22s / 5s) |
| Mutations run | 16, each killed by a named test (§4) |

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
| `fontFamily` removed from the SVG text nodes | font-substitution + Type1 tests |
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

The fix is a lock file (`wx`, stale-broken by age, timeout-bounded) serialising a ~0.5s build.
That is deliberately blunter than per-step atomicity, because per-step atomicity did not
actually stop peers destroying each other's work. `tests/readings-wheel-pdf.test.ts` spawns six
concurrent builders and fails if the lock is removed.

**Review it as infrastructure, not as feature code.** If you would rather the four suites shared
one build (a global setup) instead of serialising, that is a bigger change and belongs in its
own PR; this one keeps the blast radius small.

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

Two of eight threads remain open at `4cc8585`, both in `tests/readings-wheel-pdf.test.ts`,
both with a reply naming the fix and the mutation that now fails:

- page/PDF label parity (extra PDF-only label)
- paid Placidus output (anchor shift)

Everything else is resolved. The PR needs an approving review and those two threads resolved
before `staging`'s branch policy will allow the merge.

## 9. Authority

The operator is the sole merge, deploy and promotion authority. This handoff authorises no
merge, no deployment, no workflow dispatch and no migration. Per the operator's 2026-11-19
sequencing, staging QA, the back-merge PR and promotion wait until the operator says the
branch is ready.
