# Slice 1-b — pure wheel geometry projection (issue #153)

**Implementation plan, not evidence of completion.** This is the detailed design for
one issue, recorded so it can be implemented and reviewed in one round rather than
discovered during review.

Design authority is [Saved chart facts and the factual wheel](plan-solar-wheel-facts.md);
this document does not restate or amend that contract. It expands only S1-b
(that file, lines 470–562 at `f8f20ae`) into an ordered, testable work plan and records
the decisions that were open when the slice was handed over. Direction is
[ADR 011](decisions.md#adr-011--solar-return-first-and-a-shared-four-product-offer).

Nothing here authorizes a hosted migration, deployment, promotion, environment or
control change, provider/Stripe call, credential setup, generation activation, or a
change to Free/paid allowance accounting.

## 1. Scope

| | |
| --- | --- |
| In scope | `src/lib/wheel.ts` (new), `tests/wheel.test.ts` (new), `src/lib/i18n.ts` (label vocabulary, see D1) |
| Out of scope | Any component, any PDF change, any database change, any payload plumbing |
| Deploy class | **`deploy:skip`** — no `drizzle/`, no config, no runtime flag, no new dependency |

S1-b adds **no component**. The existing `src/components/astro-wheel.tsx` stays exactly
where it is — home hero, `/sample`, usage guide — and keeps its "decorative, not a plot
of this chart" labelling. It is not a starting point and must not be modified.

The module's whole reason to exist is that two emitters must agree: S1-c renders the
same `WheelGeometry` into page `<svg>`, S1-d renders it into PDF `<Svg>`. That is why
it must stay pure, why coordinates round to 3 dp, and why the label set must already
be PDF-glyph-safe before either emitter exists.

## 2. Base and prerequisites

| | |
| --- | --- |
| Repo | `jtanori/solara` |
| Base commit | `f8f20ae3f4342e2bb94801a9e3ba61d8bf258e9b` — squash merge of PR #156 (S1-a). **#152 was not auto-closed**; see §14 |
| PR target | `staging` (never `main`; `main` is promotions only) |
| Merge method | squash, `feature → staging` |

The local clone has been fast-forwarded to `f8f20ae`. Confirm before starting:

```bash
git rev-parse --short HEAD          # f8f20ae
ls drizzle/0009_reading_chart_facts.sql src/readings/chart-facts.ts
```

The branch named in the previous handoff (`arena/3ef408d9-solara`) **does not exist**,
locally or on `origin`. Create the working branch from the base commit:

```bash
git switch -c feat/153-wheel-geometry f8f20ae
```

S1-a must be present, not merely merged upstream: `ChartFacts` gains its storage
contract from that slice, and `docs/plan-solar-wheel-facts.md` only exists from
`f8f20ae` onward.

## 3. Decisions

Settled before implementation; each one would otherwise surface mid-review.

| # | Decision | Rationale |
| --- | --- | --- |
| **D1** | Body, angle and node labels are localized through a **new `pointName(id, locale)` in `src/lib/i18n.ts`** | `signName()` already exists there for signs; the wheel must not invent a second label vocabulary. Adds one file to the diff. |
| **D2** | Cusps are projected from **stored `facts.houses`**, never recomputed | One source of truth for both house systems. `wholeSignCusps()` is used in tests only, to assert exact 30° spacing. |
| **D3** | The label charset guard is **Unicode-aware Latin**, not `A-Z` | Spanish labels carry `é`, `ú`, `ó` (`Géminis`, `Júpiter`, `Plutón`). An ASCII regex fails every Spanish wheel. |
| **D4** | `factsVersion` is a **locally declared literal type**, not `typeof BASE_FACTS_VERSION` | Importing `@/readings/chart-facts` pulls in `canonical-hash.ts` → `node:crypto`, which is forbidden for a pure module. A test asserts the two values are equal. |
| **D5** | `projectWheel` accepts `ChartFacts \| null \| undefined` | Otherwise `facts_unavailable` is unreachable vocabulary. |
| **D6** | `WheelGeometry` gains **`aspectTotal: number`** | The acceptance criterion "exposes the true total" has no field to expose it in as sketched. Additive; no consumer exists yet. |
| **D7** | `elementCount` uses the counting rule in §6.8, with 4 minor ticks per sign | "≤ 260" is unfalsifiable without a written rule. |
| **D8** | A dropped label keeps a **radial leader stub of 8 units** | The plan requires the stub but does not size it; any fixed value is emittable. Cosmetic and asserted only for presence. |

D1 and D6 are contract additions relative to the parent plan. Both belong in the PR
body under *Deviations from plan*. Neither changes the deploy class.

## 4. Public contract

Exported from the parent plan (lines 100–150 and 478–519), with exactly two marked
changes relative to it: `FactsVersion` (D4) and `aspectTotal` (D6).

```ts
export type FactsVersion = "base-facts/1";           // see D4

export type WheelOmission =
  | "facts_unavailable" | "ascendant_unavailable" | "houses_omitted"
  | "natal_not_plotted" | "cross_aspects_not_plotted"
  | "aspects_truncated" | "labels_omitted";

export type WheelPoint = {
  id: string;                 // "Sun", "Ascendant", "TrueNode", …
  label: string;              // localized, ≤ WHEEL_MAX_LABEL_CHARS, Latin only
  kind: "body" | "angle" | "node";
  longitude: number;
  angle: number;              // exact projected screen angle
  anchor: { x: number; y: number };
  labelPosition: { x: number; y: number };
  labelAngle: number;
  band: "A" | "B" | null;     // null = unlabelled
  leader: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
};

export type WheelGeometry = {
  factsVersion: FactsVersion;
  houseSystem: "whole-sign" | "placidus";
  viewBox: number;
  radii: typeof WHEEL_RADII;
  anchorLongitude: number;
  signs: { index: number; label: string; startAngle: number; endAngle: number; labelAngle: number }[];
  houses: { number: number; cuspLongitude: number; angle: number; midAngle: number }[];
  points: WheelPoint[];
  chords: { a: string; b: string; type: AspectType; orb: number }[];
  aspectTotal: number;        // see D6
  unlabelled: string[];
  omissions: WheelOmission[];
  elementCount: number;
};

export const WHEEL_VIEW_BOX = 440;                  // square; centre 220,220
export const WHEEL_RADII = {
  outer: 152, signRing: 128, houseRing: 114, aspectRing: 94,
  labelBandA: 170, labelBandB: 194,
} as const;
export const WHEEL_MIN_LABEL_SEPARATION_DEG = 9;
export const WHEEL_MAX_LABEL_NUDGE_DEG      = 14;
export const WHEEL_MAX_CHORDS               = 24;
export const WHEEL_MAX_LABEL_CHARS          = 12;
export const WHEEL_MAX_ELEMENTS             = 260;

export function wheelAngle(longitude: number, anchorLongitude: number): number;
export function longitudeAt(angle: number, anchorLongitude: number): number;
export function wheelPoint(angle: number, radius: number, viewBox?: number): { x: number; y: number };
export function projectWheel(facts: ChartFacts | null | undefined, locale: Locale): WheelGeometry | null;
```

**Import discipline** is an acceptance criterion, not a preference. `src/lib/wheel.ts`
imports only `@/lib/astro`, **types** from `@/lib/chart`, and `@/lib/i18n`. Never
`server-only`, never `node:*`, never the database, never `@/readings/*`.

## 5. The projection invariant

SVG is y-down: `0°` = 3 o'clock, `90°` = 6 o'clock, `180°` = 9 o'clock, `270°` = 12
o'clock. The Ascendant is anchored **left** and ecliptic longitude increases
**counter-clockwise on screen**.

```ts
wheelAngle(λ, A)  = normalize(180 + A − normalize(λ))
longitudeAt(a, A) = normalize(180 + A − normalize(a))     // exact inverse
wheelPoint(a, r)  = { x: cx + r·cos(a·DEG), y: cy + r·sin(a·DEG) }   // cx = cy = 220
```

Consequences to assert numerically, never by inspection:

| Given | Expected | Why it matters |
| --- | --- | --- |
| `λ = A` | `180` | Ascendant on the left |
| `λ = A + 90` | `90` | IC at the bottom |
| `λ = A + 180` | `0` | Descendant on the right |
| `λ = A + 270` | `270` | MC at the top |
| `λ₂ = λ₁ + 10` | `angle₂ = angle₁ − 10 (mod 360)` | Longitude advances counter-clockwise |
| `longitudeAt(wheelAngle(λ, A), A)` | `λ` within `1e-9` | The involution — the strongest single orientation check |

Orientation depends on **longitude only**. Southern-hemisphere and eastern-longitude
fixtures must anchor identically; a mirrored or rotated wheel is a defect even when
every individual point looks plausible.

**Round at emission, not during arithmetic.** `wheelAngle` and `longitudeAt` return
unrounded values; `wheelPoint` rounds its two coordinates to 3 dp. Rounding inside
`wheelAngle` breaks the `1e-9` involution for reasons unrelated to orientation, and
a broken involution test then hides a real mirroring bug.

## 6. Algorithm

Single call, no I/O, no mutation of the input. Ordered so each step's inputs exist.

### 6.1 Guard

Return `null` when `facts == null`, `facts.angles.ascendant == null`, or
`facts.houses.length !== 12`. Never substitute `0° Aries`. 264 of 3168 surveyed charts
land here (`|latitude| ≥ 66`); the wheel is omitted, never invented.

### 6.2 Points

Assemble exactly 14, in this fixed order (assembly order is fixed for stable snapshots;
collision ties are broken by `id`, §6.6):

| Source | `id` | `kind` |
| --- | --- | --- |
| `facts.bodies[0..9]` | `Sun`, `Moon`, `Mercury`, `Venus`, `Mars`, `Jupiter`, `Saturn`, `Uranus`, `Neptune`, `Pluto` | `body` |
| `facts.angles.ascendant` | `Ascendant` | `angle` |
| `facts.angles.midheaven` | `Midheaven` | `angle` |
| `facts.nodes.trueNode` | `TrueNode` | `node` |
| `facts.nodes.southNode` | `SouthNode` | `node` |

For each: `angle = wheelAngle(p.longitude, A)`, `anchor = wheelPoint(angle, WHEEL_RADII.outer)`.

**Label from `id`, never from `placement.body`.** `src/lib/chart.ts:378` and `:382`
store both nodes with `body: "Moon"` because `BodyName` has no node member. Labelling
from `placement.body` renders the True Node as "Moon"/"Luna" — a duplicate Luna, with
no type error and no obvious visual tell.

### 6.3 Signs

Twelve entries from `SIGN_NAMES`, indexed `0..11`:

```ts
startAngle = wheelAngle(i * 30, A)
endAngle   = wheelAngle(normalize((i + 1) * 30), A)
labelAngle = wheelAngle(normalize(i * 30 + 15), A)   // the sign's midpoint longitude
label      = signName(SIGN_NAMES[i], locale)
```

Sign labels come from the ring index, not from any stored placement. The
sign-before-rounding hazard in §15 item 4 is therefore not reachable here, and the
wheel must not add a per-point sign field that would make it reachable.

### 6.4 Houses

Project `facts.houses` (D2) at `WHEEL_RADII.houseRing`. For cusp screen angles
`a_i`, `a_{i+1}`:

```
delta = normalize(a_i − a_{i+1})
mid   = normalize(a_i − delta / 2)
```

Correct for unequal Placidus sectors as well as uniform whole-sign ones.

If **any** `delta` is `0` or `≥ 180`, omit the house ring entirely — `houses: []`
plus `houses_omitted` — rather than draw a suspect sector. Partial rings are worse
than none because the drawing still looks authoritative.

### 6.5 Chords

Only from `facts.aspects`. Never from `facts.crossAspects`.

1. Map each aspect endpoint id to a projected point; **drop** any aspect naming a point
   absent from the facts (never fabricate a position).
2. `aspectTotal` = the number of resolvable aspects *before* truncation (D6).
3. Sort by `orb` ascending; the tiebreak must be total and deterministic — `(orb, a, b)`
   with code-unit string comparison, not `localeCompare` (which varies with ICU).
4. Keep the first `WHEEL_MAX_CHORDS`; set `aspects_truncated` when
   `aspectTotal > WHEEL_MAX_CHORDS`.

Self-aspects (`a === b`) are impossible upstream but must not emit a zero-length chord
if they ever appear: drop them, and do not count them in `aspectTotal`.

### 6.6 Collision handling

Deterministic, pure, single pass. **Anchors never move.**

1. Order points by `angle`; ties by `id` with code-unit comparison.
2. Place each label in band A. If it is within `WHEEL_MIN_LABEL_SEPARATION_DEG` of a
   label already placed in that band, nudge by the smallest whole degree, up to
   `WHEEL_MAX_LABEL_NUDGE_DEG`, in the direction that increases separation.
   Candidate order must be written down: `0, −1, +1, −2, +2, … ±14`. Tie direction is
   fixed, not "whichever was tried first".
3. If band A is exhausted, try band B under the same rule.
4. If both bands are exhausted, drop the label: `band = null`, push the id to
   `unlabelled`, set `labels_omitted`, and keep a radial leader stub (D8).
5. Emit a leader whenever `separation(labelAngle, angle) > 0.5°`.

Circular separation is `min(|Δ|, 360 − |Δ|)` after normalizing `Δ`.

`labelPosition = wheelPoint(labelAngle, band === "A" ? labelBandA : labelBandB)`.

The single most important guard in this slice: a mutant that moves the anchor instead
of the label must fail. A displaced anchor silently misstates a position while the
chart still looks valid.

### 6.7 Omissions

| Code | Set when |
| --- | --- |
| `facts_unavailable` | input is `null`/`undefined` (geometry not returned; see §8) |
| `ascendant_unavailable` | Ascendant is null (geometry not returned; see §8) |
| `houses_omitted` | a cusp `delta` is `0` or `≥ 180` |
| `natal_not_plotted` | `facts.natal` carries any positions |
| `cross_aspects_not_plotted` | `facts.crossAspects.length > 0` |
| `aspects_truncated` | `aspectTotal > WHEEL_MAX_CHORDS` |
| `labels_omitted` | `unlabelled.length > 0` |

Emit in the union's declared order so snapshots are stable.

### 6.8 Element count

Per D7:

```
elementCount = 1                         // zodiac ring
             + signs.length  * 2         // boundaries + labels
             + houses.length * 2         // cusp lines + numbers (0 when omitted)
             + signs.length  * 4         // minor ticks
             + points.length             // anchor dots
             + labelled.length           // label glyph groups
             + leaders.length            // leader lines
             + chords.length
```

Largest fixture: `1 + 24 + 24 + 48 + 14 + 14 + 14 + 24 = 163`, against a ceiling of
`260`. Headroom is real; if a future slice adds a ring, the ceiling is what stops it
from silently blowing the PDF time budget.

## 7. Labels and i18n

### 7.1 `pointName` in `src/lib/i18n.ts`

Mirror `signName()` exactly: takes `string`, falls back to the input, imports nothing.
`i18n.ts` is imported by ~80 modules, many client-side; it must not gain a dependency
on `astro.ts` for a label table.

English needs its own map because `TrueNode` must render as `True Node`.

```ts
const pointLabelsEn: Record<string, string> = {
  Sun: "Sun", Moon: "Moon", Mercury: "Mercury", Venus: "Venus", Mars: "Mars",
  Jupiter: "Jupiter", Saturn: "Saturn", Uranus: "Uranus", Neptune: "Neptune",
  Pluto: "Pluto", Ascendant: "Ascendant", Midheaven: "Midheaven",
  TrueNode: "True Node", SouthNode: "South Node",
};
const pointLabelsEs: Record<string, string> = {
  Sun: "Sol", Moon: "Luna", Mercury: "Mercurio", Venus: "Venus", Mars: "Marte",
  Jupiter: "Júpiter", Saturn: "Saturno", Uranus: "Urano", Neptune: "Neptuno",
  Pluto: "Plutón", Ascendant: "Ascendente", Midheaven: "Medio Cielo",
  TrueNode: "Nodo Norte", SouthNode: "Nodo Sur",
};
export function pointName(point: string, locale: Locale) {
  return locale === "es" ? pointLabelsEs[point] ?? point : pointLabelsEn[point] ?? point;
}
```

### 7.2 Length and charset

`WHEEL_MAX_LABEL_CHARS = 12`; the worst cases are `Sagittarius` 11,
`Capricornio` 11, `Medio Cielo` 11, `South Node` 10. Do not rely on that arithmetic —
assert **every** label for **both** locales, so a future i18n edit fails loudly instead
of being silently truncated.

Allowed characters: Latin letters (including diacritics), digits, `°`, space. Implement
with `\p{Script=Latin}` or an equivalent Unicode property, not an ASCII class (D3).

### 7.3 PDF glyph gate

The gate is `pdfGlyphsSupported()` at `src/readings/pdf-fonts.ts:29`, enforced for every
PDF at `src/components/solar-pdf.tsx:49` (throws `409 pdf_glyphs`). S1-d will pass every
wheel label straight into that `strings` array, so S1-b must prove it holds:

> a test that collects all point labels, sign labels and house numbers for **both
> locales** and asserts `pdfGlyphsSupported(all, renderer)` is true.

That test is what prevents an accented Spanish label from making every Spanish PDF fail
three slices from now. It is not in the 12 acceptance boxes; add it anyway.

## 8. Omissions that cannot be returned

`facts_unavailable` and `ascendant_unavailable` describe states in which
`projectWheel` returns `null` — a `null` geometry cannot carry an `omissions` array.
Decision: keep both codes in the union, because the *notice vocabulary* is shared with
S1-c/S1-d and the caller needs one list to render from, but document at the type that
`projectWheel` emits neither. Do not invent a placeholder geometry to make them
reachable; that is the `0° Aries` failure in a different costume.

## 9. Determinism

- **Deep equality across repeated calls** and **across shuffled input array order**.
  Achieved by sorting at every point where order could otherwise leak: points by
  `(angle, id)`, aspects by `(orb, a, b)`.
- **No `Date`, no `Math.random`, no I/O, no Node-only import.** Asserted by reading the
  source in a test — the established technique in this repo is
  `tests/readings-facts.test.ts:416–419`, which imports `readFileSync` and asserts both
  what must appear and what must not.
- **No `localeCompare`.** It is environment-dependent and would make snapshots differ
  between CI and a developer machine.
- **3 dp everywhere a coordinate is emitted**, so page and PDF bytes are stable.

## 10. Fixtures

Build every fixture from real output before writing assertions against it. Guessed
constants produced dead tests in S1-a. Probe with a throwaway script in `.scratch/`
(gitignored).

| Fixture | How |
| --- | --- |
| F1 synthetic reading | `readingChartInput` from `tests/helpers/reading-fixtures.ts:14` → `calculateSolarReturn` + `solarReturnFacts` (`src/lib/solar.ts`) |
| F2 high latitude | return place with `|latitude| ≥ 66` → `ascendant === null` |
| F3 Placidus narrow | a Placidus chart with at least one sector `< 30°` |
| F4 Placidus wide | same chart, a sector `> 30°` |
| F5 southern + eastern | mirrored hemisphere/longitude pair; anchoring must be identical |
| F6 >24 aspects | clone a real `ChartFacts` and append aspects (a fixture value, not a DB row) |
| F7 absent endpoint | clone and add an aspect naming `"PartOfFortune"` |
| F8 cross-aspects | clone and append to `crossAspects` |
| F9 collision cluster | clone and place four bodies within 9° of each other |
| F10 `es` labels | F1 with `locale: "es"` |

F2 must assert `null` and must also assert that no alternative code path returns a
wheel — a "fallback" branch is the defect this fixture exists to catch.

## 11. Test plan

### 11.1 The 12 acceptance boxes → named tests

| # | Acceptance (parent plan, 524–551) | Test |
| --- | --- | --- |
| 1 | Projection consequences, involution, four anchors | `wheel: anchors the ascendant left and the axes at the four cardinals` |
| 2 | Whole-sign cusps 30° apart; Placidus cusps unequal; mid-angle for narrow and wide sectors | `wheel: projects whole-sign cusps 30 degrees apart`, `wheel: keeps Placidus cusps at their own longitudes`, `wheel: places house numbers at the sector mid-angle` |
| 3 | Cusp `delta` of `0` or `≥ 180` omits the house ring | `wheel: omits the house ring when a cusp delta is degenerate` |
| 4 | Southern/eastern fixtures anchor identically | `wheel: does not mirror the wheel in the southern hemisphere or east longitude` |
| 5 | Null Ascendant or `houses.length !== 12` → `null` | `wheel: returns null without an ascendant and never substitutes zero Aries` |
| 6 | Chords only from `aspects`; cross-aspects yield the omission and no `natal-` endpoint | `wheel: never draws cross-aspects as chords` |
| 7 | >24 aspects keeps the tightest 24 by orb, sets `aspects_truncated`, exposes the total | `wheel: keeps the 24 tightest aspects and reports the true total` |
| 8 | An aspect naming an absent point is dropped, not fabricated | `wheel: drops an aspect whose endpoint is not in the facts` |
| 9 | Collision: anchors fixed, nudges ≤14°, dropped labels recorded, deep-equal across repeats and shuffles | `wheel: never moves an anchor during collision handling`, `wheel: is deep-equal across repeated and shuffled input` |
| 10 | Labels ≤12 chars, allowed charset, all coordinates inside the viewBox with ≥6 margin | `wheel: keeps every label short, Latin and inside the viewBox` |
| 11 | `elementCount ≤ WHEEL_MAX_ELEMENTS` on the largest fixture | `wheel: stays inside the element budget` |
| 12 | No `Date.now`, randomness, I/O or Node-only import | `wheel: source has no clock, randomness, I/O or Node-only import` |

### 11.2 Additional tests

| Test | Asserts |
| --- | --- |
| `wheel: labels a node as a node, not as the Moon` | `pointName`/`WheelPoint.label` for `TrueNode` is never `Moon`/`Luna` — the §6.2 trap |
| `wheel: every label in both locales passes the PDF glyph gate` | §7.3, via `pdfGlyphsSupported` |
| `wheel: factsVersion matches the stored contract` | `FactsVersion` equals `BASE_FACTS_VERSION` — the test may import `@/readings/chart-facts`; the module may not (D4) |
| `wheel: emits coordinates at three decimal places` | bit-stable output |
| `wheel: returns an empty-but-valid geometry when houses are omitted` | `houses: []` + omission, points still plotted |

## 12. Mutations (SEC-07)

Nine targets from the parent plan, 553–562. Patch one at a time, run the scoped suite,
record the **named** failing test, restore, and confirm `git diff` is clean. A mutant
that fails to compile is **not** a kill.

| Mutant | Patch | Expected failure |
| --- | --- | --- |
| `wheel-anchor-mirrored` | `180 + A − λ` → `180 + A + λ` | `anchors the ascendant left…` and the involution test |
| `wheel-asc-not-left` | constant `180` → `90` | `anchors the ascendant left…` |
| `wheel-move-anchor-on-collision` | recompute `anchor` from `labelAngle` | `never moves an anchor during collision handling` |
| `wheel-plot-cross-aspects` | read `crossAspects` into `chords` | `never draws cross-aspects as chords` |
| `wheel-fabricate-anchor` | `ascendant ?? 0` | `returns null without an ascendant…` |
| `wheel-placidus-uniform-cusps` | derive cusps as `A + 30i` regardless of system | `keeps Placidus cusps at their own longitudes` |
| `wheel-unbounded-chords` | drop the 24 cap | `keeps the 24 tightest aspects…` |
| `wheel-label-unbounded` | drop the 12-char/charset guard | `keeps every label short, Latin and inside the viewBox` |
| `wheel-nondeterministic-order` | remove the pre-sort / use insertion order | `is deep-equal across repeated and shuffled input` |

Record the matrix as a table in the PR body: mutant → test → pass/fail → restored.

## 13. Verification gates

Scoped work first; the full suite is expensive and CI runs it on every push.

```bash
npm ci
npx tsx --test tests/wheel.test.ts        # the slice's own suite, no DB needed
npm run typecheck                        # tsc --noEmit
npm run lint                             # eslint src tests scripts --max-warnings=0
```

Full suite and build (needs a disposable local database; see the
`docs/plan-solar-wheel-facts.md` and `AGENTS.md` recipes). Per
`docs/CODE_REVIEW.md` §6, state why and wait for authorization before spending it:

```bash
RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts
npm run build
```

Two practical notes:

- `tests/helpers/deployment-inputs.ts:8` builds its fixture from
  `git ls-files --cached`, so **`git add` the new files early**. An untracked module
  only breaks that gate if a *tracked* file imports it — nothing will here — but adding
  early costs nothing and removes the question.
- Do not edit the tree while the suite is running. Two earlier mass-failure captures in
  this repo were self-inflicted concurrency artifacts.

## 14. Tracker and PR

1. **#153** `status:blocked` → `status:ready` (its only dependency, #152, is merged).
2. **#152 is still open.** GitHub auto-closes an issue only when the PR merges into the
   *default* branch; this repo's default is `main` and the PR targeted `staging`. Close
   it by hand with a comment naming `f8f20ae`.
3. **Park the deploy record.** `docs/deploys.md` carries one uncommitted row
   (`2026-11-18T23:19Z | staging | f8f20ae | 156 | applied (staging) | ok`). It is
   accurate and worth landing, but not inside a `deploy:skip` wheel PR. Stash it or
   commit it separately before starting.
4. Open the PR against `staging`, `deploy:skip`, body from
   `.github/pull_request_template.md`: *Linked issue*, *Evidence*, *Deviations from
   plan* (must name `src/lib/i18n.ts` and `aspectTotal`), *Mutations (SEC-07)* table,
   *Pre-PR attestation*, *Deploy classification*.

`scripts/pr-lint.mjs` wants a conventional title, a `type:*` label and one of
`deploy:required`/`deploy:skip`. `gh pr edit --body-file` has silently failed in this
repository while printing an unrelated GraphQL warning — PATCH through
`gh api` and read the body back.

**Authority:** the operator is the sole merge and deploy authority. Do not merge, close,
promote, deploy, dispatch workflows, or run `scripts/db-remote.ts`.

## 15. Landmines

Each one has already cost a review round or a chart in this project.

1. **The branch in the earlier handoff does not exist.** `arena/3ef408d9-solara` is
   absent locally and on `origin`. Create `feat/153-wheel-geometry` from `f8f20ae`.
2. **Both nodes store `body: "Moon"`** (`src/lib/chart.ts:378`, `:382`). Label points
   from `id`, never from `placement.body`, or the wheel shows two Lunas.
3. **Do not import `@/readings/chart-facts`** for `factsVersion`. It reaches
   `canonical-hash.ts` → `node:crypto` (`src/readings/canonical-hash.ts:1`), which
   breaks the purity criterion and the client safety of the eventual component.
4. **`castChart` rounds the stored longitude but takes the sign before rounding**
   (`src/lib/chart.ts:389` vs `:390`). An Ascendant of `119.99999042980204` is Cancer
   and stores as `120`. The wheel does not read `sign`, and must not start — if a
   future slice needs a sign, read `facts.*.sign`.
5. **Anchors never move.** Labels nudge or drop. A displaced anchor still looks like a
   valid chart while misstating a position; this is the mutation the review weights
   most.
6. **`crossAspects` are never chords.** They link a return point to a natal point.
   Drawing one inside a single return ring asserts a relationship between two return
   positions that does not exist.
7. **Spanish labels carry diacritics** (`Géminis`, `Cáncer`, `Júpiter`, `Plutón`). An
   ASCII charset regex rejects them, and a glyph the subset lacks would fail *every*
   Spanish PDF at `409 pdf_glyphs`. Assert the gate, both locales.
8. **`localeCompare` is environment-dependent.** Use code-unit comparison for every
   tiebreak, or snapshots will differ between CI and a laptop.
9. **Round only at emission.** Rounding inside `wheelAngle` collapses the `1e-9`
   involution and hides orientation defects behind a precision failure.
10. **Untracked files and `tests/helpers/deployment-inputs.ts:8`.** The fixture copies
    only tracked files; add new files early so the deployment-input typecheck never
    sees a half-added tree.
11. **Do not touch `src/components/astro-wheel.tsx`.** It is decorative, stays on the
    marketing pages, and is not a base for this work.
12. **Do not edit while testing**, and keep throwaway probes in `.scratch/`. Two
    mass-failure captures in this repo were self-inflicted concurrency artifacts.
13. **`docs/deploys.md` has one uncommitted row.** Park it outside this PR (§14, step 3).

## 16. What comes after

| Slice | Issue | Deploy | Consumes |
| --- | --- | --- | --- |
| 1-c — page wheel + numerical table | #154 | `deploy:required` | `WheelGeometry` in page `<svg>`; fixes the hardcoded "Placidus" summary at `src/components/reading-page-view.tsx:38` |
| 1-d — same geometry into PDF | #155 | `deploy:required` | `WheelGeometry` in PDF `<Svg>`; every label joins the `pdfGlyphsSupported` `strings` array |

One projection, two emitters. That is the contract this slice establishes; if S1-c or
S1-d has to recompute an angle, S1-b was wrong.

Still in `phase:solar` afterwards: #103, #109, #81, #105 (`p0`, needs-info), #92, under
epic #99.

## 17. Corrections to the 2026-11-18 handoff

Recorded so the next reader does not chase the same five discrepancies.

| Handoff claim | Actual |
| --- | --- |
| Branch `arena/3ef408d9-solara` "already created and checked out" | Does not exist locally or on `origin`; the session was on `staging` @ `ec5e17e`, one commit behind |
| "No `origin/staging` tracking ref mapped, use `FETCH_HEAD`" | The tracking ref is mapped and healthy; the clone had simply not fetched since the merge |
| "13 acceptance boxes" | **12** (`### Acceptance` at 522, boxes 524–551) |
| Purity precedent at `tests/readings-facts.test.ts:410` | The test starts at 410, but the source-inspection technique is at **416–419** |
| "Untracked files break the deployment-input test" | Only when a *tracked* file imports the untracked one; harmless advice, imprecise mechanism |

Everything else in that handoff verified against `f8f20ae`: the merge commit and time,
the presence of `chart-facts.ts` / `canonical-hash.ts` / `drizzle/0009`, every file:line
citation quoted in this plan, the plan document's section boundaries, the constant values,
the 9 mutation names, and the `docs/deploys.md` deploy row.

## 18. Definition of done

- [ ] `src/lib/wheel.ts` and `tests/wheel.test.ts` added; `src/lib/i18n.ts` gains
      `pointName` with both maps.
- [ ] All 12 acceptance boxes pass, plus the five additional tests in §11.2.
- [ ] All 9 mutants produce a named failing test; matrix recorded; tree restored.
- [ ] Scoped suite, `tsc`, and `eslint --max-warnings=0` green locally.
- [ ] PR opened against `staging` with `deploy:skip`, body read back after PATCH.
- [ ] #153 at `status:ready` (then `in-review`), #152 closed by hand naming `f8f20ae`.
- [ ] `docs/deploys.md` row parked or landed separately, not inside this PR.

