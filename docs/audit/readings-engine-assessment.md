# Readings engine — current state and options

Audit date: 2026-11-08. Scope: how a reading is produced today, what the `knowledge` table
actually does, and what it would take to produce a real solar-revolution interpretation.

## Verdict in one line

**The astronomical calculation is real; the interpretation layer is a lookup table of
12 per-sign sentences with an admin override; nothing in the product is AI-generated, and
nothing resembling a solar-revolution interpretation exists yet.** The `knowledge` table is
not a rules base — it holds one editable sentence per sun/moon/ascendant sign and per house.

## 1. What actually happens on a reading request

`POST /api/readings` (`src/app/api/readings/route.ts`):

1. `sameOrigin()` + `currentUser()` — needs a signed-in user.
2. `calculateSolarReturn(input)` — `src/lib/solar.ts`, 77 lines, uses `astronomy-engine` 2.1.19 (MIT).
3. Persist `{ input, result }` into `readings` (jsonb). **No text is generated or stored.** The
   narrative is composed at render time from whatever `knowledge` holds *now*.

So a saved reading is a *chart snapshot*, not a document. Re-render it after an editorial change
and the user's reading changes underneath them. That is fine for a prototype and wrong for
content that people pay for.

### What the calculation engine genuinely does

| Computed | Method | Notes |
|---|---|---|
| Natal Sun longitude | `SunPosition(birth)` | Real ephemeris (VSOP87-derived) |
| Exact solar-return instant | `SearchSunLongitude` over a 14-day window around the birthday | Correct approach; handles the ±1 day drift |
| Return Moon longitude | `Ecliptic(GeoVector(Body.Moon, …))` | Real |
| Ascendant | sidereal time + obliquity approximation, `abs(lat) < 66` | Real method, one approximation (`epsilon` linear series) |
| Sun house | whole-sign, from the ascendant's sign | Real within that house system |

It is honestly labelled: `engine: "Astronomy Engine · apparent geocentric ecliptic of date"`, and it
always appends *"Prototype calculation: independently verify the result and historical time-zone
rules before using it as a professional chart."* DST ambiguity and high latitude are handled
deliberately (offset choice, houses omitted above 66°). `tests/solar.test.ts` exists.

Licence note: `astronomy-engine` is **MIT** — fine for commercial use. (Swiss Ephemeris, the other
common choice, is AGPL-or-paid and would need a licence review; the repo already says so in
`setup-guide.tsx`.)

### What it does not compute — the list that matters

- **Only 3 bodies**: Sun, Moon, Ascendant. No Mercury, Venus, Mars, Jupiter, Saturn, Uranus,
  Neptune, Pluto, Chiron, nodes, or Lilith.
- **No aspects** — no conjunction/trine/square/orb logic anywhere in `src/`.
- **No Midheaven**, no other house systems (Placidus is explicitly not offered, with a stated reason).
- **No birth-chart (natal) profile** beyond the natal Sun sign — no natal Moon, natal ascendant,
  no natal house placement. The user's *birth* data is used only to find the Sun's longitude.
- **No cross-chart work**: no transits, progressions, profections, returns of other planets, or
  synastry with the return chart.
- **No timezone history resolution** beyond `tz-lookup` + `luxon`; historical LMT/zone changes
  before the tz database's coverage are unverified (the warning says as much).

For a product whose promise is a solar revolution reading, that is roughly **10% of the input
surface**: a real solar-return interpretation is built from the return chart as a whole (all
planets, their houses and aspects, plus the natal chart it activates), not from three positions.

## 2. What the `knowledge` table is

```sql
knowledge(key text primary key, title text, body text, updated_at timestamptz)
```

Read by `src/lib/reading-content.ts` → `getReadingNotes()`: it derives up to **four keys** per
reading (`sun-<sign>`, `moon-<sign>`, `ascendant-<sign>`, `house-<n>`, each with `-es` for Spanish),
looks them up with `inArray`, and falls back to `defaultNote()` in `src/lib/content.ts`. That
fallback is 12 English + 12 Spanish sentences for sun/moon/ascendant, plus a house sentence
template — the entire interpretive corpus of the product.

Written only by `PUT /api/admin/knowledge`, which validates `category ∈ {sun, moon, ascendant, house}`,
`item` ∈ 12 signs or house 1–12, body ≤ 4000 chars, and writes an `audit_logs` row.

Characteristics that define the ceiling:

- **Key space is fixed in code** (`contentKey`, `CONTENT_CATEGORIES`, `SIGNS_FOR_CONTENT`). Adding a
  new kind of statement needs a code change, not a data change.
- **No relations.** One body per (category, item). No "Sun in Leo *and* Moon in Pisces *and* Saturn
  in the 7th" — which is where all the interpretive value of a chart actually lives.
- **No versioning** — `updated_at` only. No way to answer "what text did the user see in March?".
- **Not seeded.** No seed script; the table starts empty and the defaults are code-side.
- **Localised by duplicated keys** (`-es` suffix), not by a locale column.

So: the `knowledge` table is a **CMS for 48–72 sentences**, not a knowledge base.

## 3. What the product shows today

`src/app/reading/[id]/page.tsx` renders `result.exactUtc`, `natalSun`, `moon`, `ascendant`,
`sunHouse`, the house system, the warnings, and the four `notes.*` strings. The wizard collects:
name, birth date, birth time, birth place, return place, year, DST choice — a 6-step flow, all of
it currently feeding three positions and four sentences.

Nothing is mocked in the sense of fake data: the numbers are computed. What is *thin* is the
narrative — and thin in a way that a user paying for "a reading" would notice immediately.

## 4. Nothing exists in the backlog for this

Grepping 42 open issues for readings/engine/knowledge/interpretation/AI returns **no product
issue**. The closest neighbours are about *verifying outputs* and *delivering* them:

- #70 readiness checks (includes a "fixture chart" idea — proving a known birth produces a known chart)
- #71 schema/readiness verification in AGENTS.md
- #81 PDF artefact + storage architecture (the delivery format for a generated reading)
- #83 realtime update channel (billing/artefacts)
- #85 legal pages, consent, SEO

There is **no issue for the interpretation engine, the astrology domain model, or the content
pipeline.** The whole product surface is unplanned. That is the main finding.

## 5. Two paths, honestly compared

### Path 1 — deterministic / rule-based engine

Compute the full return chart, then compose text from rules and content fragments:
`planet × sign`, `planet × house`, `aspect × planet pair`, each a piece of editorial content
keyed and versioned in the database.

- **Pros**: deterministic, testable, auditable, cheap per reading, no per-request cost, stable
  output (the same chart reads the same in 2031), no data-processing agreement needed for
  personal data, no hallucination risk on a product where users may act on what it says.
- **Cons**: proportional content effort — 10 bodies × 12 signs × 12 houses plus aspect variants
  plus natal interaction is **thousands of editorial units in two languages**. And generic
  fragments read like a horoscope column: "Sun in Leo" text says nothing about *this* user's year.
  Combining fragments well is its own hard problem (it is why professional readings are written by
  a person).

**Cost reality**: the content is the expensive part, not the code. The code is a few weeks; the
corpus is months, or a lot of money.

### Path 2 — AI generation per reading, cached

Send the computed chart as structured JSON to an LLM with a strict output schema, generate the
narrative once, store it on the reading, reuse.

- **Pros**: dramatically better prose than fragment assembly, handles the combinatorial explosion
  (no need to author every combination), can be guided by a curated knowledge base as context,
  and can produce genuinely personalised text with almost no editorial lead time.
- **Cons**: non-deterministic unless heavily constrained; needs a schema + validation + retry
  loop; per-request latency and cost; needs an eval harness so quality does not silently drift;
  personal data (birth date/time/place) leaves your infrastructure unless you pick a provider
  with the right terms — a real privacy and consent question for a product in Mexico and the US;
  and it is only as good as the chart it is given, so it **does not remove the need for the
  astronomy work in §1** — it multiplies it.

**The mistake to avoid**: wiring an LLM to the three positions you compute today. The output would
read beautifully and say almost nothing specific — because the input is three data points. The
engine work and the generation work are additive, not alternatives.

## 6. Recommendation

Both, in this order, and the first step is cheap:

1. **Decide the domain model first** (the "what does a solar revolution reading contain"
   question). It is content/domain work, not engineering, and it determines both paths. Output:
   a `ChartResult` v2 listing bodies, houses, aspects and the natal chart — with a declared
   minimum viable set ("MVP reading = these 12 statements") rather than "everything an astrologer
   would consider".
2. **Expand the calculation to that model.** Extend `solar.ts` (or add a layer beside it) to all
   planets, aspects with orbs, Midheaven, and the natal chart. `astronomy-engine` already covers
   every body needed and is MIT — no new dependency, no licence problem. Keep `tests/solar.test.ts`
   and add fixture charts compared against a trusted ephemeris (this is what #70's fixture idea
   supports).
3. **Then choose the narrative mechanism per statement class**, not for the whole product:
   - *Stable, high-traffic statements* (planet in sign, planet in house) → editorial content in a
     proper keyed/versioned table, reusable across users, cheap forever.
   - *Personalised synthesis* ("what this year asks of you, given all of it") → AI, generated once
     per reading, schema-validated, stored on the row, regenerable on demand.
   That hybrid gets the quality of AI where it matters and the determinism of content where it is
   cheap — and keeps per-reading cost near zero for the bulk of the text.
4. **Snapshot the output** whatever the mechanism: store the generated narrative and a
   `contentVersion` on the reading. Today re-rendering changes history; that must not survive
   into production, especially for anything paid.

### Why not just start with AI everywhere

Because the blocking problem is input, not prose. A prompt fed with `sun sign + moon sign + sun
house` produces a well-written useless reading, and you would pay per request to discover that.
The sequence in §6 costs one domain-design session and one engine sprint before you spend a peso
on inference — and it also gives you something concrete to evaluate AI output against.

## 7. What this means for the current backlog

Nothing above is tracked. Suggested split, to be filed as issues (not done yet — this document is
the input for that decision):

- **epic: readings engine** — domain model + chart v2 + fixture charts (the old "knowledge as
  rule base" idea lives here, redefined)
- **readings: interpretive content model** — versioned, keyed statements; replaces the 48-sentence
  table as the source of truth; migration path for existing `knowledge` rows
- **readings: narrative generation** — mechanism decision (content vs AI vs hybrid), output schema,
  storage on the reading, `contentVersion`
- **readings: AI provider + privacy** — provider choice, data-processing terms, PII handling,
  consent copy, cost model, eval harness
- **readings: snapshot and regeneration** — store the rendered narrative; explicit regenerate path

Cross-links: #81 (PDF/storage consumes the narrative), #83 (realtime progress for a slow
generation step), #70/#71 (fixture-based verification), #82 (retention/erasure of PII sent to a
provider), #85 (consent copy).

## 8. Open questions for the product owner

1. **What is the paid artefact?** A rendered PDF of N sections, or an interactive page? This
   decides whether generation must be synchronous or can be a job (#81, #83).
2. **How personal may the text be?** Free will / disclaimers are already in the copy ("an
   invitation, not a prediction") — how far does the generated text go beyond that line?
3. **Which chart facts are non-negotiable?** If a professional astrologer reviewed one reading and
   said "this is missing X", what would X be? That is the MVP scope for §6.1.
4. **Tolerance for per-reading cost?** A number per reading, at launch volume, is the input to
   choosing the hybrid split in §6.3.
5. **Who owns the editorial voice?** If it is you, AI output needs heavy review; if it is a
   hired astrologer, the content path becomes viable and the hybrid shifts toward content.
