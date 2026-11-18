# Slice 1 — saved chart facts and the factual wheel (page + PDF)

**Implementation plan, not evidence of completion.** Detailed design for delivery
slice 1 of [Solar Return completion](plan-solar-return-completion.md), recorded so
the work can be implemented and reviewed in one round per issue. Direction is
[ADR 011](decisions.md#adr-011--solar-return-first-and-a-shared-four-product-offer).
GitHub Issues remain the execution tracker; this document holds the design detail
each issue links to, and is not a second backlog.

Nothing here authorizes a hosted migration, deployment, promotion, environment or
control change, provider/Stripe call, credential setup, generation activation, or a
change to the existing Free/paid allowance accounting. The additive migration this
slice introduces is `deploy:required` and fail-closed against un-migrated instances
(see [Rollout](#rollout-and-deploy-implications)).

## Verified baseline

Audited at staging `ec5e17ecb5d7e6cbb019a86d64594230e54992c8`. These are read
findings, not newly executed checks.

| Existing code | What it provides | Consequence for this slice |
| --- | --- | --- |
| `src/lib/chart.ts` | `castChart()` → `ChartFacts` (`chart/2`): 10 bodies, angles, true/south node, 12 cusps, internal `aspects`, `crossAspects`, natal bodies, element/modality `balance`. `wholeSignCusps()` and `placidusCusps()` both pinned against Swiss Ephemeris in `tests/ephemeris.test.ts`. Longitudes rounded to 4 dp. | The fact source already exists and is validated. This slice **stores and draws** it; it does not re-derive astrology. |
| `src/lib/solar.ts` | `calculateSolarReturn()` → the small `ChartResult`; `calculateSolarReturnChart()` → `{ result, facts }`, whole-sign by default. | The base save path calls only `calculateSolarReturn()`, so no facts are persisted today. |
| `src/lib/types.ts` | `ChartResult`: `exactUtc`, `localTime`, `natalSun`, `moon`, `ascendant|null`, `sunHouse|null`, `houseSystem: "Whole sign"`, `warnings`, `engine`. | Four placements only. Too small for a wheel; must stay byte-compatible for legacy rows. |
| `src/readings/chart-save.ts` | Single `insert(readings).values({ userId, year, input, result })` behind `readings:create:*` budgets; explicit comment that saving is deterministic and never generates. | The one place a facts row may be added. Generation and entitlement boundaries are untouched. |
| `src/readings/chart-presentation.ts` | `readChart()` validates the stored row with `chartSchema` and enforces the requested house system; `readingSelector()`; `chartNotes()`. | Extend with an optional validated facts field. Legacy rows must still parse unchanged. |
| `src/readings/presentation.ts` | `ReadingChart` already has optional `calculation?: ReadingBlock[]`; `READING_LIMITS` (`chartBytes` 16 KiB, `documentBytes` 512 KiB, `pdfPages` 40, `paidPdfPages` 80). | The table path already exists end-to-end — base charts can reuse it without renderer changes. |
| `src/readings/reading-view.ts` | SELECT-only `chartColumns`, with an `octet_length(...) <= chartBytes` guard that yields `null` rather than an oversized payload; paid path returns `calculation: paidCalculationBlocks(snapshot, locale)`. | Add the facts column with the same guard style. Paid already proves the pattern. |
| `src/readings/paid-chart.ts` | `PaidSnapshot` freezes full Placidus `facts` + `chart`, byte-bounded (`PAID_SNAPSHOT_BYTES` 128 KiB), hash-verified (`paidSnapshotHash`), revalidated on every read and on worker recovery. | Paid editions need **no new storage** for a wheel: their facts are already pinned. The geometry module must therefore be house-system agnostic. |
| `src/readings/paid-presentation.ts` | `paidCalculationBlocks()` — the existing bilingual bounded fact-table pattern (`keyValue`/`aspectTable`, 24-row display cap). | Mirror it for base charts instead of inventing a second table style. |
| `src/components/astro-wheel.tsx` | `AstroWheel`: hardcoded 7 angles and 11 chords, no data. Used by the reading page (with an honest "decorative" label), the home hero, `/sample` and the usage guide. | Reading page stops using it. Marketing/sample/usage-guide keep it — no chart exists there. |
| `src/components/reading-page-view.tsx` | Renders `AstroWheel`, the placement cards, `chartDetails`, and `chart.calculation` inside a `<details>` whose summary **hardcodes "Placidus"**. | That hardcoded label is a defect once base charts carry whole-sign blocks; it must become edition-aware. |
| `src/components/solar-pdf.tsx` | Renders `chartDetails`, `chartPlacements`, `chart.calculation` blocks and sections; `pdfGlyphsSupported(strings, renderer)` throws `409 pdf_glyphs` before layout; page caps enforced in the footer render callback. | Wheel must join the same input, and every wheel label must join `strings`. |
| `src/readings/pdf-render.ts` / `pdf-worker.ts` | Both independently enforce `documentBytes + chartBytes` on the serialized worker input. | Two copies of one bound. Adding facts must change **both**, and a test must pin their agreement. |
| `drizzle/` | Migrations `0000`–`0008`; journal `idx` 8; manifest checked by `npm run db:manifest:check`. | Next migration is `0009`, journal `idx` 9. Never rewrite an applied file. |
| `src/lib/schema-verification.ts` | 24 `REQUIRED_TABLES`, 22 `REQUIRED_INDEXES`, 19 `REQUIRED_COLUMNS` entries. | Gains one table, one index and the new column entries. |

### Renderer capability — verified, not assumed

The PDF approach depends on whether `@react-pdf/renderer` can draw vector
geometry. `node_modules` is not installed in the planning workspace, so this was
verified by downloading and reading the exact published packages pinned in
`package-lock.json`:

- `@react-pdf/renderer@4.9.0` runtime is `export * from '@react-pdf/primitives'`,
  and `@react-pdf/primitives@4.4.0` exports `Svg, G, Circle, Ellipse, Line, Path,
  Polygon, Polyline, Rect, Text, Tspan, Defs, ClipPath, Marker, LinearGradient,
  RadialGradient`. Its `index.d.ts` declares `Svg` with `viewBox` and
  `preserveAspectRatio` props.
- `@react-pdf/layout@5.2.0` implements them: `resolveSvgRoot(node, fontStore)`,
  `parseViewbox`, `parseAspectRatio` (default `{ align: 'xMidYMid', meetOrSlice:
  'meet' }`), `SVG_INHERITED_PROPS`, `addMissingTspan`, and a Yoga svg measure
  function. It also resolves `transformOriginX/Y`.
- `@react-pdf/render@4.7.0` paints them: `[P.Svg]: renderSvg`, `[P.G]:
  renderGroup`, `[P.Circle]: renderCircle`, `[P.Line]: renderLine`, `[P.Path]:
  renderPath`, `[P.Rect]: renderRect`, `[P.Ellipse]: renderEllipse`, `[P.Polygon]:
  renderPolygon`, `[P.Polyline]: renderPolyline`, `[P.Text]: renderSvgText`, with
  marker support on line-like primitives.
- `@react-pdf/stylesheet@6.3.2` parses `transform: rotate(angle, cx, cy)`.

**Conclusion:** real SVG primitives render inside the PDF, so page and PDF can be
driven by *one* geometry module emitting the same structure, rather than by two
independent drawing implementations that must be kept visually equal by hand.
`@react-pdf/svg` is present in the lockfile but is **not** a dependency of
renderer 4.9.0 and is not used by this design; no new dependency is added.

**Hard constraint this creates:** `renderSvgText` draws through the registered
`Solara Noto Sans` faces — the vendored **Latin subset** documented in
[`docs/setup/04-pdf.md`](setup/04-pdf.md). Astrological glyphs (`☉ ☽ ♈…♓`,
U+2609/U+263D/U+2648–U+2653) are not in that subset, so a glyph-labelled wheel
would fail `pdfGlyphsSupported` and return `409 pdf_glyphs` for every download.
Wheel labels must therefore be **localized Latin words and digits only** — the same
vocabulary `paidCalculationBlocks()` already uses successfully in PDFs, including
`°`. This is why the design forbids glyph labels rather than treating them as a
style choice.

## Issue breakdown

Four linear, separately reviewable issues. Each is intended to land well under
400 changed lines of production code plus its tests; if one grows materially
larger, split it and say so in the PR rather than bundling.

| Issue | Title | Depends on | Production surface |
| --- | --- | --- | --- |
| **S1-a** | `readings: persist versioned whole-sign chart facts at save time` | — | migration `0009`, schema, save path, read/validation |
| **S1-b** | `readings: pure wheel geometry projection with tested orientation` | S1-a | `src/lib/wheel.ts` only — no UI, no I/O |
| **S1-c** | `readings: factual wheel and numerical facts on the reading page` | S1-b | page component, base fact blocks, notices |
| **S1-d** | `readings: factual wheel in the PDF with shared geometry` | S1-c | PDF document, input bounds, glyph set, snapshots |

Rationale for the order: S1-a is data-only and can be reviewed against migration
and privacy rules without any visual judgement. S1-b isolates the highest-risk
logic (orientation, collision, omission) in a pure module where every assertion is
a numeric equality — defects found there are cheap, defects found in a rendered
SVG are not. S1-c and S1-d then consume an already-proven projection, so each is
mostly integration and honest-labelling work.

---

## Shared contracts

Fixed before S1-a starts, so no issue re-opens another's decisions.

```ts
// src/lib/wheel.ts — pure; no Date.now, no I/O, no Node-only or server-only import.
export const BASE_FACTS_VERSION      = "base-facts/1";
export const BASE_CALCULATION_POLICY = "whole-sign-return-v1";
export const BASE_FACTS_BYTES        = 64 * 1024;   // stored + serialized bound
export const WHEEL_VIEW_BOX          = 440;         // square; centre 220,220
export const WHEEL_RADII = {
  outer: 152, signRing: 128, houseRing: 114, aspectRing: 94,
  labelBandA: 170, labelBandB: 194,
} as const;
export const WHEEL_MIN_LABEL_SEPARATION_DEG = 9;
export const WHEEL_MAX_LABEL_NUDGE_DEG      = 14;
export const WHEEL_MAX_CHORDS   = 24;   // matches the existing display limit
export const WHEEL_MAX_LABEL_CHARS = 12;
export const WHEEL_MAX_ELEMENTS = 260;  // PDF time/heap budget
```

### Projection — the pinned invariant

Screen angles use SVG's y-down system: `0°` = 3 o'clock, `90°` = 6 o'clock,
`180°` = 9 o'clock, `270°` = 12 o'clock. The Ascendant is anchored at the left and
ecliptic longitude increases **counter-clockwise on screen**:

```ts
wheelAngle(λ, λ_ASC) = normalize(180 + λ_ASC − normalize(λ))
wheelPoint(angle, r) = { x: 220 + r·cos(angle·DEG), y: 220 + r·sin(angle·DEG) }
longitudeAt(angle, λ_ASC) = normalize(180 + λ_ASC − normalize(angle))   // exact inverse
```

Consequences that must be asserted, not assumed:

- `λ = λ_ASC` → `180°` (left). `λ_ASC + 90` → `90°` (bottom, the IC).
  `λ_ASC + 180` → `0°` (right, the Descendant). `λ_ASC + 270` → `270°` (top, the MC).
- `λ₂ = λ₁ + 10` → `angle₂ = angle₁ − 10 (mod 360)`: increasing longitude moves
  counter-clockwise, so houses and signs both advance counter-clockwise.
- `longitudeAt(wheelAngle(λ, A), A) ≡ λ` within `1e-9` for every fixture longitude
  (the projection is an involution — a strong single-property check on orientation).
- Whole-sign cusps are exactly `30°` apart on screen; Placidus cusps are **not**,
  and must be plotted at their own longitudes.
- Orientation depends only on longitude. Southern-hemisphere and eastern-longitude
  fixtures must produce the same anchoring, never a mirrored wheel.
- All emitted coordinates are rounded to 3 dp, so page and PDF bytes are stable and
  snapshot comparisons are meaningful.

### House sector mid-angle

For cusp screen angles `a_i`, `a_{i+1}`: `delta = normalize(a_i − a_{i+1})`,
`mid = normalize(a_i − delta / 2)`. This is correct for unequal Placidus sectors as
well as uniform whole-sign ones. If any `delta` is `0` or `≥ 180`, the house ring is
**omitted** with a notice rather than drawn from a suspect sector.

### What is plotted

| Plotted | Not plotted |
| --- | --- |
| Zodiac sign ring with localized sign names and 30° boundaries | Any natal body or natal angle on the wheel (`natal_not_plotted`) |
| House cusp lines and house numbers, in the saved house system | Any `crossAspects` chord (`cross_aspects_not_plotted`) |
| 10 bodies, Ascendant and Midheaven when present, true and south node | Any point not present in the saved facts |
| Return-internal aspects, tightest 24 by orb, with `aspects_truncated` + total when more | Degrees in wheel labels (they live in the table; keeps labels ≤ 12 chars) |

Cross-aspects link a return point to a natal point. Drawing them as chords inside a
single return ring would assert a relationship between two return positions that
does not exist, so they appear **only** in the numerical table, labelled with the
existing `(natal)` suffix convention.

### Collision handling

Deterministic, pure, single pass:

1. Order points by screen angle, ties broken by a fixed point-id ordering (never by
   object-key order or array identity).
2. Place each label in band A; if it is within `WHEEL_MIN_LABEL_SEPARATION_DEG` of a
   label already placed in that band, nudge it by the smallest multiple of `1°` up to
   `WHEEL_MAX_LABEL_NUDGE_DEG` in the direction that increases separation.
3. If still colliding, place it in band B under the same rule.
4. If both bands are exhausted, **drop the label** and record it in the geometry's
   `unlabelled` list. The anchor dot stays at its exact projected angle and keeps a
   short leader stub; the numerical table always carries the full data.
5. Emit a leader line from anchor to label whenever `|labelAngle − angle| > 0.5°`.

The anchor is never moved. A mutant that moves the anchor instead of the label must
fail; that is the single most important guard in this slice, because a displaced
anchor silently misstates a position while still looking like a valid chart.

### Missing data

`projectWheel()` returns `null` when the facts have no Ascendant or do not carry 12
cusps (today: `|latitude| ≥ 66`). The page and PDF then render **no wheel** and an
explicit notice. The rejected alternative — anchoring at `0° Aries` so "a wheel still
renders" — is refused in writing: it presents an invented horizon as the user's, and
the existing code already refuses to compute an Ascendant there rather than
approximate one.

Omission codes, each rendered as a bilingual notice:
`facts_unavailable`, `ascendant_unavailable`, `houses_omitted`, `natal_not_plotted`,
`cross_aspects_not_plotted`, `aspects_truncated`, `labels_omitted`.

### Privacy and ownership

Facts are derived from birth input and are **not** anonymous or non-personal data.
They inherit the reading's ownership: owner-only SELECT, never logged, never placed
in an error message, and never sent anywhere. `ChartFacts` carries no name, email,
birth date, birth time, birth place or coordinate — `natal` holds positions only, and
the natal *instant* is not stored. A test asserts the serialized facts contain none
of the saved `input`'s values, mirroring the existing digest privacy checks.

---

## S1-a — persist versioned whole-sign chart facts at save time

**User outcome:** a newly saved Solar Return chart carries the full deterministic
calculation it was drawn from, so a factual wheel and complete numerical table can be
rendered later without recomputation. Existing charts are unchanged and visibly
labelled as lacking it.

**In scope:** migration `0009`, Drizzle table, save-path write, read/validation,
legacy behaviour, schema-verification entries.
**Out of scope:** any UI, any geometry, backfill, recasting, provider work, tier or
allowance changes, hosted migration.

### Persistence

New insert-only table, following the `reading_documents` precedent rather than adding
a mutable column to `readings` — the original saved `result` must never be updated:

```ts
export const readingChartFacts = pgTable("reading_chart_facts", {
  id: uuid("id").defaultRandom().primaryKey(),
  readingId: uuid("reading_id").notNull().references(() => readings.id, { onDelete: "cascade" }),
  factsVersion: text("facts_version").notNull(),        // "base-facts/1"
  calculationPolicy: text("calculation_policy").notNull(),
  houseSystem: text("house_system").notNull(),          // "whole-sign"
  chartVersion: text("chart_version").notNull(),        // "chart/2"
  facts: jsonb("facts").$type<ChartFacts>().notNull(),
  factsHash: text("facts_hash").notNull(),              // canonicalHash(facts)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("reading_chart_facts_reading_version_key").on(table.readingId, table.factsVersion),
]);
```

- The unique index leads with `reading_id`, so it also serves per-chart lookups;
  **no second index** (the same reasoning already documented for
  `reading_documents_reading_locale_version_key`).
- `ON DELETE CASCADE`: facts are meaningless without their chart, and chart deletion
  accounting already exists. The deletion tests must be extended, not assumed.
- No UPDATE path exists anywhere. A future facts version inserts a new row.
- Migration `0009_reading_chart_facts.sql` is additive `CREATE TABLE` +
  `CREATE UNIQUE INDEX` only; journal entry `idx: 9`, `version: "7"`,
  `breakpoints: true`, matching `0008`. `npm run db:manifest` regenerates the
  manifest; `0000`–`0008` bytes and hashes are unchanged.

### Write path

In `src/readings/chart-save.ts`, after `result` is computed and before the response:

1. `const facts = solarReturnFacts(input, result)` — a new pure helper in
   `src/lib/solar.ts` that casts from `result.exactUtc` and `input.returnPlace`, with
   the natal moment from the existing `resolveBirthTime(input)`. `calculateSolarReturnChart()`
   is refactored to call it so there is exactly one cast path and its own exported
   contract is unchanged.
2. Coherence gate — all must hold or the facts are **not** written:
   - `facts.at === result.exactUtc`
   - `facts.houseSystem === "whole-sign"` and `facts.chartVersion === "chart/2"`
   - 10 distinct bodies; 10 distinct natal bodies
   - `result.ascendant` and `facts.angles.ascendant` are both null or both present,
     and when present agree within `0.0001°` (documented tolerance: `ChartResult`
     keeps unrounded values, `castChart` rounds to 4 dp)
   - `result.sunHouse === facts.bodies.find(Sun).house` when both non-null
   - `result.moon` agrees with the facts' Moon within `0.0001°`
   - `serializedFacts` ≤ `BASE_FACTS_BYTES`
3. One transaction inserts the reading and its facts row.

Failure semantics, deliberately asymmetric:

- **Cast or coherence failure → the chart still saves**, with no facts row, and a
  `readings.facts_unavailable` warning log carrying a stable non-PII code. Facts are
  a display enhancement; a calculation edge case must never regress saving, and must
  never be papered over with invented data.
- **Facts INSERT failure → the transaction rolls back** and the existing 500
  `database_write_failed` response is returned. No orphan row, no half-written chart.
- Budgets, validation, trimming of `input.name`, the 400/401/429 paths and the
  response shape are unchanged. Saving still never generates, never spends an
  allowance and never calls a provider.

### Read path

- `chartColumns` gains
  `facts: sql<unknown>\`case when octet_length(${readingChartFacts.facts}::text) <= ${BASE_FACTS_BYTES} then ${readingChartFacts.facts} else null end\``
  via a `LEFT JOIN` on `readingId` and `factsVersion = BASE_FACTS_VERSION`. The join
  must not change row count or ownership filtering, and chart reads must stay
  independent of unavailable generation tables (the existing `try`/`catch` fallback to
  `store.chart()` keeps working).
- `readChart()` accepts an optional facts payload, validates it with a new
  `baseFactsSchema` (whole-sign variant: `houseSystem: z.literal("whole-sign")`,
  `ascendant` nullable, `houses` length 12 **or** 0, natal bodies length 10,
  `placidusValidated` still `true` as `castChart` emits it), re-checks `factsHash`
  and the same coherence rules, and returns `ReadingChart` with `facts?: ChartFacts`.
- **Over-size, malformed, incoherent or hash-mismatched facts are treated as
  absent**, with a `readings.facts_rejected` warning log and the
  `facts_unavailable` notice — never a 500 and never a partial wheel that
  contradicts the summary beside it.
- Legacy rows (no facts) parse exactly as today. `readChart`'s existing house-system
  argument and the paid `readPaidSnapshot` path are untouched.

### Acceptance

- [ ] `npm run db:manifest && npm run db:manifest:check` pass; `npm run db:migrate`
      applies 9 migrations to a fresh disposable loopback database; `npm run db:check`
      reports the new table/index/column counts with no pending or unexpected journal
      hashes. Record the actual counts in the PR body.
- [ ] A fresh-`0008` database upgraded through `0009` keeps every existing row and
      leaves `readings.result` bytes unchanged.
- [ ] Saving a valid chart writes exactly one facts row with `factsVersion
      "base-facts/1"`, `houseSystem "whole-sign"`, and a hash that
      `canonicalHash(facts)` reproduces.
- [ ] A second save of the same input writes a second reading with its own facts row;
      a duplicate `(readingId, factsVersion)` insert is refused by the unique index
      (asserted against real PostgreSQL, not mocked).
- [ ] Deleting a chart cascades to its facts; the existing deletion-accounting and
      `actorId`-preserving tests still pass unchanged.
- [ ] A forced cast failure saves the chart with **no** facts row, logs the stable
      code, and returns the same `{ id }` response as today.
- [ ] A forced facts-insert failure rolls back: no reading row, no facts row, 500.
- [ ] Each coherence rule is violated once in a test and refuses to write facts.
- [ ] A legacy row with no facts reads successfully; `readChart` output for a
      pre-existing fixture is byte-identical to its output before this change.
- [ ] Oversize and malformed facts read as absent, with the notice and no 500.
- [ ] Serialized facts contain no value from the saved `input` (name, birth date,
      birth time, place names, latitude, longitude, timezone).
- [ ] No provider call, no generation dispatch, no consent or allowance mutation
      occurs during save (assert the existing zero-fetch/zero-POST guards).

### Verification

Standing full validation applies (`npx next typegen`; `npm run typecheck`;
`npm run lint`; `RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx
--test tests/*.test.ts`; `npm run build`) on a disposable loopback database with
generation explicitly off and no hosted secrets. Scoped first:
`npx tsx --test tests/readings-db.test.ts tests/readings-view.test.ts
tests/readings-migrations.test.ts tests/schema-verification.test.ts
tests/db-check.test.ts tests/chart.test.ts tests/solar.test.ts`.

### Mutation targets

`facts-recast-on-read` (compute facts during a GET when absent) ·
`facts-backfill-update` (add an UPDATE/backfill path) ·
`save-facts-blocks-chart` (let a cast failure fail the save) ·
`facts-orphan-on-insert-failure` (drop the transaction) ·
`facts-incoherent-accepted` (skip the `exactUtc` equality) ·
`facts-hash-unverified` (skip the hash recheck on read) ·
`facts-oversize-500` (throw instead of treating as absent) ·
`facts-pii-leak` (add a birth field to the serialized facts) ·
`facts-legacy-row-rejected` (make a missing facts row fail `readChart`).

Each must produce a named assertion failure and be restored; record the matrix in the
PR body as prior slices did.

---

## S1-b — pure wheel geometry projection

**User outcome:** none directly. This is the correctness core: one pure module that
turns saved facts into bounded, deterministic drawing instructions.

**In scope:** `src/lib/wheel.ts` and its tests.
**Out of scope:** any component, any PDF change, any new data.

### API

```ts
export type WheelOmission = "facts_unavailable" | "ascendant_unavailable" | "houses_omitted"
  | "natal_not_plotted" | "cross_aspects_not_plotted" | "aspects_truncated" | "labels_omitted";

export type WheelPoint = {
  id: string;                 // stable: "Sun", "Ascendant", "TrueNode", …
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
  factsVersion: typeof BASE_FACTS_VERSION;
  houseSystem: "whole-sign" | "placidus";
  viewBox: number;
  radii: typeof WHEEL_RADII;
  anchorLongitude: number;
  signs: { index: number; label: string; startAngle: number; endAngle: number; labelAngle: number }[];
  houses: { number: number; cuspLongitude: number; angle: number; midAngle: number }[];
  points: WheelPoint[];
  chords: { a: string; b: string; type: AspectType; orb: number }[];
  unlabelled: string[];
  omissions: WheelOmission[];
  elementCount: number;
};

export function wheelAngle(longitude: number, anchorLongitude: number): number;
export function longitudeAt(angle: number, anchorLongitude: number): number;
export function wheelPoint(angle: number, radius: number, viewBox?: number): { x: number; y: number };
export function projectWheel(facts: ChartFacts, locale: Locale): WheelGeometry | null;
```

Localization is a parameter so page and PDF produce identical labels from one call
site each; the module imports only `@/lib/astro`, `@/lib/chart` types and `@/lib/i18n`
— never `server-only`, `node:*` or the database.

### Acceptance

- [ ] Every projection consequence listed above is asserted numerically, including
      the involution round-trip and the four cardinal anchors.
- [ ] Whole-sign cusps render exactly 30° apart; a Placidus fixture renders cusps at
      its own unequal longitudes, and the house mid-angle formula is asserted for a
      sector narrower and a sector wider than 30°.
- [ ] A cusp `delta` of `0` or `≥ 180` omits the house ring with `houses_omitted`
      instead of drawing it.
- [ ] Southern-hemisphere and eastern-longitude fixtures anchor identically; no
      fixture produces a mirrored or rotated wheel.
- [ ] `facts.angles.ascendant === null` or `facts.houses.length !== 12` → `null`,
      and no code path substitutes `0° Aries`.
- [ ] Chords come only from `facts.aspects`; a fixture with cross-aspects yields
      `crossAspects_not_plotted` and zero chords referencing a `natal-` endpoint.
- [ ] More than 24 aspects keeps the tightest 24 by orb, sets `aspects_truncated`,
      and exposes the true total.
- [ ] An aspect naming a point absent from the facts is dropped, not drawn to a
      fabricated position.
- [ ] Collision fixtures: anchors stay at their exact projected angles in every case;
      nudges never exceed `WHEEL_MAX_LABEL_NUDGE_DEG`; unplaceable labels are dropped
      into `unlabelled` with `labels_omitted` set; output is deep-equal across
      repeated calls and across shuffled input array order.
- [ ] Every label is ≤ `WHEEL_MAX_LABEL_CHARS`, contains no character outside the
      Latin/digit/`°`/space set, and every point/house/sign coordinate lies inside the
      viewBox with ≥ 6 units of margin.
- [ ] `elementCount` ≤ `WHEEL_MAX_ELEMENTS` for the largest fixture (all 14 points,
      24 chords, 12 signs, 12 houses, ticks).
- [ ] The module has no `Date.now`, no randomness, no I/O and no Node-only import
      (asserted by source inspection in a test, as other boundaries already are).

### Mutation targets

`wheel-anchor-mirrored` (flip the sign of the λ term) · `wheel-asc-not-left` (anchor
constant 180 → 90) · `wheel-move-anchor-on-collision` · `wheel-plot-cross-aspects` ·
`wheel-fabricate-anchor` (0° Aries fallback) · `wheel-placidus-uniform-cusps` ·
`wheel-unbounded-chords` (drop the 24 cap) · `wheel-label-unbounded` (drop the
12-char/Latin restriction) · `wheel-nondeterministic-order` (sort by insertion order
instead of the fixed tiebreak).

---

## S1-c — factual wheel and numerical facts on the page

**User outcome:** the reading page shows the user's actual chart — positions, houses,
angles, nodes and aspects — with an honest label, an accessible numerical equivalent,
and explicit omissions. A chart saved before this work says so plainly instead of
showing a decorative wheel that implies positions it does not have.

**In scope:** `src/components/chart-wheel.tsx`, base fact blocks, notices, the
`reading-page-view.tsx` swap, `chart.calculation` for base charts.
**Out of scope:** PDF, marketing pages, geometry changes, new data.

### Rendering

- The wheel is a **server component** emitting SVG from `WheelGeometry`:
  `<svg viewBox="0 0 440 440" role="img" aria-labelledby=…>` with `<title>`/`<desc>`
  naming the chart, house system, return instant and that the numerical table is the
  authoritative equivalent. `role="img"` plus a label keeps assistive technology from
  reading 200 decorative nodes; the table is the accessible path.
- The existing `.chart-wheel` CSS class is reused; the container must not overflow at
  the half-width/200%-density viewport the browser tests already emulate.
- Base fact blocks come from a new `baseCalculationBlocks(facts, locale)` mirroring
  `paidCalculationBlocks`: return placements with sign, degree, house and
  retrograde/direct/stationary; whole-sign cusps; angles and nodes; natal reference
  positions; return aspects and return-to-natal aspects as `aspectTable`s capped at 24.
  They are attached to `ReadingChart.calculation`, so the **existing** page and PDF
  block renderers display them with no new block kind and no registry change.
- The `<details>` summary in `reading-page-view.tsx` must become edition-aware: base
  charts say whole sign, paid editions keep saying Placidus. Leaving it hardcoded is a
  visible correctness defect the moment base blocks exist.
- The decorative-disclaimer notice on the reading page is **removed only where a real
  wheel is drawn**, and replaced by the house-system/omission notices. Where geometry
  is `null` or facts are absent, no wheel is rendered and the notice explains why and
  how to get one (save a new chart). `AstroWheel` stays on the home hero, `/sample`
  and the usage guide with its decorative label intact.
- Paid editions render their wheel from `snapshot.facts` (already pinned and
  hash-verified), so a paid reader sees a Placidus wheel with no new storage and no
  recomputation. Paid output must otherwise be unchanged.

### Acceptance

- [ ] A newly saved chart's page shows a wheel whose plotted positions equal the
      saved facts (asserted by parsing the server-rendered SVG in the existing
      page/browser test style, not by screenshot alone).
- [ ] The numerical table lists all 10 bodies with sign, degree, house and motion,
      plus cusps, angles, nodes, natal reference and both aspect groups, in en and es.
- [ ] A legacy chart renders no wheel, keeps its existing four placement cards, and
      shows the `facts_unavailable` notice; the response is still 200 and the page has
      no AI controls in `?edition=chart` mode.
- [ ] A high-latitude chart renders no wheel and states that the Ascendant and houses
      are omitted — never an invented horizon.
- [ ] House system, natal-versus-return context and every omission are labelled in
      both locales.
- [ ] Cross-aspects appear only in the table, marked `(natal)`; no chord in the SVG
      connects two return points for a cross-aspect.
- [ ] Saving, viewing, language switching and navigation still trigger zero generation
      and zero provider fetches (existing guards re-asserted).
- [ ] Paid editions gain the wheel with no change to their saved snapshot, document,
      hash or existing rendered text.
- [ ] `AstroWheel` remains on the three marketing/sample surfaces with its decorative
      label; a source-level assertion records where it may still be used.

### Mutation targets

`page-decorative-fallback` (render `AstroWheel` when geometry is null) ·
`page-details-label-hardcoded` (Placidus summary for a whole-sign edition) ·
`page-fabricate-legacy-wheel` (cast facts at render time for a legacy chart) ·
`page-drop-omission-notice` · `page-cross-aspect-chord` ·
`page-paid-output-changed` (any paid snapshot/text/hash delta).

---

## S1-d — factual wheel in the PDF

**User outcome:** the downloaded PDF shows the same factual wheel and the same numbers
as the page, in the saved language, with selectable text and honest omissions.

**In scope:** `SolarReturnDocument` wheel block, worker input bounds, glyph set,
snapshot regeneration.
**Out of scope:** new dependencies, images, remote assets, page-limit changes beyond
what is measured, hosted runtime qualification (#81).

### Rendering

- Draw with `Svg` + `G`/`Circle`/`Line`/`Text`/`Tspan` primitives from the same
  `WheelGeometry` the page used — one projection, two emitters. `viewBox="0 0 440 440"`
  with an explicit width/height in points so `preserveAspectRatio` scaling is
  deterministic.
- Every wheel label string joins the `strings` array passed to
  `pdfGlyphsSupported`, so an uncovered character produces the existing honest
  `409 pdf_glyphs` rather than a PDF of boxes. Labels are Latin-only by construction
  (S1-b), and `°` is already proven by existing tables.
- The wheel is one `wrap={false}` block of fixed height, so it can never split across
  a page boundary. It is placed after the title/detail block on the first page when it
  fits, otherwise on its own page.
- The numerical table is already carried by `chart.calculation` blocks, so the PDF
  gains the table through the existing renderer path; only the wheel graphic is new.
- Page-count caps (`pdfPages` 40 / `paidPdfPages` 80) and the fixed-layout caps are
  re-asserted with the wheel present; the measured page delta is recorded in the PR.

### Bounds

Both `pdf-render.ts` and `pdf-worker.ts` enforce `documentBytes + chartBytes`. With
facts on `ReadingChart`, both become `documentBytes + chartBytes + BASE_FACTS_BYTES`,
and a test asserts the two modules compute the same bound from the same constants —
they are duplicated today, and a one-sided change would let the parent admit input the
child rejects, or the reverse. The child's environment allowlist, fs restriction,
network denial, heap/RSS ceilings, single render slot and 15 s deadline are unchanged;
no native addon or new dependency is introduced, and the wheel needs no image asset.

### Acceptance

- [ ] A base-chart PDF and a paid-edition PDF each contain the wheel, with vector
      primitives (not a raster image) and selectable Latin label text.
- [ ] Wheel label text extracted from the PDF equals the labels the page rendered for
      the same chart and locale.
- [ ] Page and PDF geometry are produced by the same `projectWheel` call signature and
      the same constants; a test renders both from one fixture and compares the emitted
      coordinate sets.
- [ ] A wheel label outside the font subset yields `409 pdf_glyphs` — no boxes, no
      silent drop, no transliteration.
- [ ] The wheel never splits across pages; the fixed-layout and page-count caps still
      hold, with the measured page delta recorded.
- [ ] Parent and child input bounds agree, asserted by test; an over-bound input is
      rejected identically on both sides.
- [ ] `tests/fixtures/readings/pdf-snapshots.json` is regenerated with
      `UPDATE_READING_PDF_SNAPSHOTS=1` **and manually visually reviewed**; the PR body
      records that review. Snapshots are never updated to make a mutation pass.
- [ ] Existing paid fixtures' text/hash snapshots change only by the intended wheel
      addition; nothing about their prose, ordering or edition identity changes.
- [ ] `npm run build && node scripts/check-pdf-package.mjs` pass; the wheel needs no
      new traced asset, and `.vercelignore` boundaries are unchanged.

### Mutation targets

`pdf-glyph-check-skipped` (wheel labels omitted from `strings`) ·
`pdf-input-limit-desync` (change the bound in only one of the two modules) ·
`pdf-wheel-splits-page` (drop `wrap={false}`) · `pdf-raster-wheel` (replace
primitives with an image) · `pdf-geometry-diverges` (recompute angles locally in the
PDF instead of using the shared module) · `pdf-snapshot-blind-update` (a test that
fails if snapshots are regenerated without the recorded manual review note).

---

## Rollout and deploy implications

- Migration `0009` makes this `deploy:required`. `scripts/db-remote.ts --check` and
  the readiness schema verification are **fail-closed**: an instance without `0009`
  reports missing table/index/columns. That is intended, and it interacts with the
  still-open #146 (artifact-download retry) and #76 (live rollback drill).
- Rollback is forward-fix or roll back to a schema-compatible reviewed build. The new
  table is additive and unread by older code, so an older build runs against a
  migrated database; a newer build must not run against an un-migrated one. Never drop
  the table to "clean up", and never rewrite `0000`–`0008`.
- No generation, provider, Stripe, mail or control-flag change. `READINGS_GENERATION_ENABLED`
  stays off. No hosted migration, deployment or promotion is performed as part of
  implementing these issues; each remains separately authorized.
- Cost impact is zero at runtime: no provider call, no new HTTP, no new dependency.
  Saving performs one additional deterministic whole-sign cast (no Placidus iteration).

## Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Add a mutable `facts` jsonb column to `readings` | Invites an UPDATE path against a row whose `result` must stay immutable; a separate insert-only table matches `reading_documents`/`generation_cache` and makes versioning structural. |
| Recast facts at GET time when absent | Recomputation is not the saved calculation, silently changes what an old chart displays, and breaks the "plot only what is saved" rule. Rejected by contract, not by cost. |
| Backfill legacy charts | Rewrites the meaning of already-delivered charts and PDFs, and would need a hosted data migration for zero user-requested benefit. Legacy charts get an honest notice instead. |
| Anchor at 0° Aries when the Ascendant is unavailable | Presents an invented horizon as the user's. The engine already refuses to approximate an Ascendant at high latitude; the wheel must refuse too. |
| Draw natal bodies and cross-aspects in the same ring | Two charts in one ring makes every chord ambiguous, and a cross-aspect drawn between two ring positions asserts a return-to-return relationship that does not exist. |
| Astrological glyph labels | Not covered by the vendored Latin PDF subset; would turn every PDF download into `409 pdf_glyphs`. |
| Rotated `View` primitives instead of `Svg` in the PDF | Verified unnecessary: renderer 4.9.0 with layout 5.2.0 and render 4.7.0 implement SVG primitives including `renderSvgText`. Two hand-maintained drawing implementations would have to be kept visually equal — the exact defect class this slice exists to remove. |
| Rasterize the wheel with `@napi-rs/canvas` | Adds a native module to the isolated, network-denied, heap- and RSS-capped PDF worker, and a dev-only dependency to the runtime path, for no capability the vector primitives lack. |
| Glyph labels on the page but Latin in the PDF | Guarantees page/PDF divergence and two label sets to test. One Latin-only label set is used by both. |

## Definition of done for slice 1

A newly saved Solar Return chart, and an existing paid edition, each show a factual
wheel and a complete bilingual numerical table on both page and PDF, derived only from
saved versioned facts, with the house system, the natal-versus-return distinction and
every omission explicitly labelled; legacy charts state honestly that full positions
were not saved and are never recast or backfilled; all four issues have killed their
named mutations and passed the restored-tree full validation; and the migration's
deploy implications are recorded rather than discovered at rollout.

Genuine LLM output is **not** part of this slice and its absence is not a defect here.
Slices 2–4 remain as described in the completion plan.
