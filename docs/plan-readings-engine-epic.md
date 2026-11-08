# Epic design — the reading document (for review)

Status: **proposal, not approved, nothing filed.** Input for the review conversation.
Follows `docs/audit/readings-engine-assessment.md` (PR #98) and the four answers given on
2026-11-08:

1. The reading should be as complete and as engaging as a real astrologer would produce
   (an astrologer is behind the product and will later work with users directly).
2. `astronomy-engine` may be used if it yields rich readings in English and Spanish.
3. Hybrid is acceptable; **the free tier shows a limited reading and the richer sections are not
   produced at all until a purchase** — "blurred" means absent, not hidden with CSS.
4. AI generation is acceptable **with explicit consent** to the privacy policy and terms.

Plus the constraint that shapes everything: **no content manager.** The client will not maintain a
CMS, and the product must be something features can be added to over time.

---

## 0. The decision in one paragraph

Build the reading as a **versioned document of typed sections**, where the *facts* are computed
deterministically and the *prose* is generated once by an LLM against a strict schema, then frozen
on the reading. Sections are registered in code and carry a tier: free sections are generated at
creation, paid sections are only generated after entitlement. The LLM receives a **PII-free chart
digest** — never a name, email or address. There is no CMS: the editable surface is a prompt file
in the repo plus an optional one-line override per section that reuses the existing `knowledge`
table. Adding a new kind of section later is a module plus a flag, not a schema migration.

## 1. Why this is the shortest path to a rich experience

| Approach | Time to first rich reading | Cost per reading | Extensible | Client burden |
|---|---|---|---|---|
| Full editorial CMS + rule engine | months (content authoring dominates) | ~0 | needs schema work per feature | **high** — rejected |
| AI for everything, engine unchanged | days | high *and* the output is generic | low | none |
| **This proposal** | **~2–3 weeks to paid-quality** | near-zero for the bulk, bounded for synthesis | **high** — section registry | none |

The reason it is fast: the expensive part of a rule-based product is *editorial volume in two
languages*. Generation removes that. The reason it is not merely "AI for everything": an LLM fed
three positions cannot be specific, so the chart work in §3 comes first and is what makes the
generated text worth paying for.

## 2. The reading document (domain model)

The persisted unit is a **document**, not a re-rendered view. Stored on the reading row beside the
existing `result` (chart snapshot), so it never changes retroactively.

```
ReadingDocument
├─ id, readingId, locale                 ("en" | "es")
├─ chartVersion                          e.g. "chart/2"
├─ contentVersion                        e.g. "reading/1.4.2"  ← prose policy + prompt version
├─ model, promptVersion, generatedAt     provenance for every word
├─ tier                                  "free" | "paid"
├─ sections: ReadingSection[]
└─ lockedSections: { key, title, teaser }[]   ← static copy, NOT generated

ReadingSection
├─ key          stable id: "overview" | "sun" | "moon" | "ascendant" | "aspects" | "houses" |
│               "nodes" | "planetaryYear" | "transits" | "profections" | "guidance"
├─ tier         "free" | "paid"
├─ title, subtitle
├─ blocks       ordered: { kind: "prose" | "callout" | "list" | "keyValue" | "aspectTable", … }
├─ facts        the chart facts this section is grounded in (for review + regeneration)
└─ status       "generated" | "overridden" | "failed"
```

Four properties this buys us, each answering something you asked for:

- **Extensible** — a new section is a new registry entry. No migration, no CMS screen. The client
  never manages structure.
- **Free/paid split is structural** — `tier` on the section, not a CSS class. Paid prose does not
  exist in the document at all for a free reading.
- **Auditable** — `facts` + `promptVersion` + `contentVersion` mean any sentence can be traced to
  inputs and to the policy that produced it. This is what makes an astrologer's review meaningful.
- **Bilingual by construction** — `locale` is a document attribute; English and Spanish are
  generated from the same facts, so the two versions describe the same chart.

### Proposed section set

Tier is a proposal; it is a product decision, cheap to change.

| Section | Tier | Grounded in |
|---|---|---|
| `overview` — the year in three paragraphs | free | ASC, Sun house, Sun/Moon signs, dominant element |
| `sun` — the year's theme | free | Sun sign, Sun house |
| `moon` — emotional weather | free | Moon sign, Moon house |
| `ascendant` — how the year meets you | free | ASC sign, chart ruler |
| `lockedSections` teaser list | free | static copy, names only |
| `aspects` — the defining geometry | paid | aspect grid with orbs |
| `houses` — where each planet lands | paid | all planets by house |
| `planets` — Mercury→Pluto, each in sign/house | paid | 9 bodies |
| `nodes` — the growth axis | paid | lunar nodes |
| `planetaryYear` — profections, yearly ruler | paid | annual profection |
| `transits` — what touches the natal chart now | paid | transit-to-natal aspects |
| `guidance` — a closing, human synthesis | paid | the whole digest |

## 3. Chart v2 — what the engine must compute first

Blocking. Every statement above is only as specific as the facts behind it.

**Available in `astronomy-engine` 2.1.19 (verified, MIT):** Sun, Moon, Mercury, Venus, Mars,
Jupiter, Saturn, Uranus, Neptune, Pluto; lunar-node events; horizon/topocentric coordinates;
sidereal time. Everything needed for positions, aspects, houses, nodes, transits, profections.

**Not available: Chiron, the major asteroids (Ceres, Pallas, Juno, Vesta), Lilith.** Adding them
means a different ephemeris — Swiss Ephemeris is AGPL-or-paid and the repo already flags that
licence question. **Decision needed:** ship MVP without them (my recommendation; they are
enrichment, not load-bearing) and revisit if the astrologer says otherwise.

Deliverables:

1. `ChartFacts` v2 — extend `ChartResult`, do not break it:
   - 10 bodies with longitude, sign, degree, house, retrograde flag
   - Ascendant, Midheaven, chart ruler, element/modality balance
   - houses: whole-sign first (already correct), Placidus later behind a flag
   - aspects: conjunction/opposition/trine/square/sextile, orbs configured per aspect and per
     body, with applying/separating where practical
   - lunar nodes (mean or true — pick one and say why)
   - natal chart *and* return chart, plus the cross-aspects between them
2. **Fixture charts** — a set of birth data with expected positions compared against a trusted
   ephemeris, committed as test fixtures. This is the only defence against silently wrong output,
   and it makes "the astrologer says the chart is wrong" a reproducible bug.
3. A **chart digest** — a compact, PII-free serialisation used as LLM input (§5).

Keep `tests/solar.test.ts` green throughout; `calculateSolarReturn` stays the public entry point.

## 4. Generation pipeline

```
reading created
   → facts = computeChartFacts(input)            deterministic, stored in `result`
   → digest = chartDigest(facts)                 PII-free, stable, hashable
   → freeDoc = generateSections(digest, FREE, locale)
        ├─ cache hit on (digestHash, section, contentVersion, locale) → reuse
        └─ miss → LLM, strict JSON schema, validate, repair-or-retry, store
   → persist ReadingDocument, tier="free"
purchase / entitlement granted
   → paidDoc = generateSections(digest, PAID, locale)  → merge, tier="paid"
```

Design rules, each with a reason:

- **Strict schema + validation.** One JSON Schema per section (`blocks` shape from §2). On
  validation failure: one repair attempt, then mark `status:"failed"` and render a graceful
  fallback. A reading is never blocked by a generation failure — the chart renders regardless.
- **Generation is idempotent and cached** on `(digest, section, contentVersion, locale)`. Two users
  with identical charts share prose; regeneration after a prompt change is explicit, not implicit.
- **Frozen prose.** Once stored, the document is immutable. A prompt or policy change bumps
  `contentVersion` and only affects *new* readings unless a regeneration is requested. This fixes
  the retroactive-edit defect identified in the audit.
- **Cost guards:** per-reading token budget, per-user monthly generation cap, paid-only
  generation, a global kill switch that degrades to chart-only readings. All four are
  configuration, not code paths sprinkled through the app.
- **Model tiering:** a cheaper model for `overview`/`sun`/`moon`/`ascendant` (short, formulaic),
  a stronger one for `guidance` (the synthesis users judge the product by). Measured, not assumed:
  the eval in §7 compares both.

## 5. Privacy — the design that makes consent easy to write

**The LLM never receives personal data.** Not a name, not an email, not a birth date, not a
birthplace — only derived chart facts:

```
{ chartVersion:"chart/2", bodies:[{body:"Sun", sign:"Leo", degree:17.4, house:5, retro:false}, …],
  aspects:[{a:"Sun", b:"Mars", type:"square", orb:1.2}, …], asc:{sign:"Scorpio"}, mc:{sign:"Leo"},
  balance:{fire:4, earth:2, air:3, water:3} }
```

Raw birth data stays in our database, used only to compute the chart. Consequences: the consent
copy is about *derived astrological facts*, the data-processing agreement is easier to obtain, the
blast radius of a provider incident is limited, and retention/erasure (#82) is unaffected because
nothing identifying was ever sent.

Consent is captured **once, versioned, at the first generation**, not buried in sign-up: a
checkbox naming the provider and the policy version, recorded with a timestamp on the user. Terms
and privacy pages are #85.

## 6. Free vs paid without a CMS

- Free: `overview`, `sun`, `moon`, `ascendant` generated. `lockedSections` is a static list of
  titles plus one line each — an honest description of what exists, written by us, no fake blur.
- Paid: the remaining sections are generated *after* entitlement, never before. This is both the
  cost control and the reason the paywall cannot be trivially defeated by reading the API response.
- The astrologer's future "interactive interpretation" is a **separate product surface** that
  consumes the same `ReadingDocument` — not a feature of generation. It needs no new engine work.

**Editable surface (deliberately tiny):** prompt/brief files per section in the repo, versioned;
plus an optional per-section override (`status:"overridden"`) written by the astrologer through
the existing admin route into `knowledge`, audited. One text field per section. **Not a CMS.**

## 7. Quality: how we know it is good

1. **Chart correctness** — fixture charts vs a trusted ephemeris, in CI (§3.2).
2. **Schema conformance** — every generated document validates; a corpus test runs N sample charts
   in both locales and asserts 100% schema validity.
3. **Editorial review** — the astrologer reviews a minimum of N generated readings per locale per
   `contentVersion` before a new version is enabled for paid users. Sign-off is recorded.
4. **Regression corpus** — a frozen set of charts whose generated text is diffed across model and
   prompt changes, so cost-driven model swaps cannot silently degrade quality.
5. **Cost/latency budget** — measured per section, asserted in the corpus test.

## 8. Proposed child issues

Ordered. Estimates assume one developer plus AI assistance; they are for sequencing, not
commitments.

| # | Issue | Depends on | Est. |
|---|---|---|---|
| 1 | `readings: domain model + chart digest` — types, schema, document shape, fixtures scaffold | — | 2d |
| 2 | `engine: chart v2` — 10 bodies, houses, MC, aspects with orbs, nodes, natal+return cross-aspects | 1 | 4–5d |
| 3 | `engine: fixture charts vs trusted ephemeris` — CI-enforced correctness | 2 | 1–2d |
| 4 | `readings: generation pipeline` — prompt registry, JSON schemas, validation, repair, cache, storage | 1 | 3–4d |
| 5 | `readings: free-tier sections + locked teasers` | 2,4 | 2d |
| 6 | `readings: consent capture + privacy copy` | 4 | 1d |
| 7 | `billing: paid-section generation on entitlement` | 4, #10, #93 | 2d |
| 8 | `readings: cost guards + kill switch` | 4 | 1d |
| 9 | `readings: eval harness + astrologer review gate` | 2,3,4 | 2d |
| 10 | `readings: renderer` — document → page/PDF (#81) | 2,5 | 2–3d |
| 11 | `engine: profections + transits` (the "all this" layer) | 2 | 3d |
| 12 | `readings: astrologer review tooling` — override field, review queue | 9 | 2d |

**Critical path to a paid-quality reading: 1 → 2 → 4 → 5 → 7 ≈ 2 weeks**, assuming #10 can take a
test payment. Items 3, 8, 9 should not slip past the first paying user; 11 and 12 follow.

## 9. Decisions taken (2026-11-08)

| # | Decision | Consequence |
|---|---|---|
| 1 | Chiron, asteroids and Lilith are **out of MVP, in scope later** | MVP ships on `astronomy-engine` alone; no Swiss Ephemeris licence question yet, no second ephemeris dependency. Reopens only if the astrologer calls one load-bearing. |
| 2 | **Whole-sign at launch, Placidus after payment** | Free readings use whole-sign (already implemented and defensible). Placidus becomes a paid-tier calculation, which means the entitlement check happens at chart level, not only at prose level — see the amendment below. |
| 3 | **True node** (mean node deferred) | Derived from `SearchMoonNode`, verified: the ascending crossing on 2026-11-17T11:47Z gives the node at 25.1° Aquarius, matching published ephemerides. Mean node is a displayed variant if the astrologer wants it. |
| 4 | Provider and budget — see §9b | Model tiering and a hard per-reading ceiling. |
| 5 | **PDF is in scope for launch** | The renderer must build the same `ReadingDocument` into a PDF; generation stays synchronous for the page, with a job path when PDF assembly exceeds the request budget (#81, #83). |
| 6 | **Two-section free reading** (`overview` + `sun`) | Reasoning and the measurement plan in §9c. |

### Amendment required by decision 2

"Placidus after payment" could be read as "computed but not shown", which contradicts decision 3
of the audit answer (paid data is *not produced* until purchase). **Paid means not computed**: the
free reading is generated from a whole-sign chart, the paid reading recomputes a Placidus chart
first and generates from that. This keeps the paywall structural rather than cosmetic, and it
means the paid path must be able to regenerate prose — which is the same mechanism as a
`contentVersion` bump, so no extra machinery.

## 10. Decisions I need from you

1. **Chiron / asteroids / Lilith** — excluded from MVP (my recommendation), or is one of them
   load-bearing for the astrologer? Excluding costs nothing; including needs a new ephemeris and a
   licence decision.
2. **House system** — whole-sign only at launch (already implemented and defensible), or Placidus
   required for paid readings? The astrologer will have an opinion, and it is cheap now, expensive
   after the first paying user.
3. **Nodes and points** — mean node vs true node; include Lilith later?
4. **Which model/provider**, and the per-reading budget in currency. This sets §4's tiering and
   whether `guidance` can be the strong model.
5. **Paid artefact format at launch** — the interactive page only, or the PDF too (#81)? PDF changes
   the renderer and implies an asynchronous job (#83).
6. **Free tier size** — are four sections right, or should `overview` alone carry the free reading?
   This is the main conversion lever and the main cost lever.

## 9b. How provider and budget would work

Three numbers decide the provider, all measurable in a day with a fixture set:

- **cost per reading** (free tier and paid tier separately),
- **latency** for the paid document (does it fit a request, or does it need a job?),
- **quality delta** between a cheap and a strong model on `overview` and `guidance` specifically.

Mechanically:

1. **Two models, chosen per section.** Short formulaic sections (`overview`, `sun`, `moon`,
   `ascendant`) use a cheap fast model; `guidance` and any synthesis section use the strong one.
   Section→model mapping lives in configuration, not code.
2. **Digest budget.** The chart digest is capped (target: under ~2k tokens) by summarising rather
   than dumping — a table of 10 bodies × sign/house is compact; aspects are filtered to the
   configured orb set. The digest is asserted against a size budget in the corpus test so it
   cannot silently grow.
3. **Per-reading ceiling.** A hard token ceiling per document, enforced before dispatch; exceeding
   it is a configuration error that fails the run rather than a surprise invoice.
4. **Per-user monthly cap.** Counted per generation, with the free tier counted separately from
   paid. Exceeding it degrades to chart-only rendering, never to an error page.
5. **Global kill switch.** One flag disables generation and leaves the deterministic chart and its
   computed facts rendering. This is the provider-outage path as well.
6. **Cache first.** Identical `(digestHash, section, contentVersion, locale)` reuses prose, so the
   common case — sun sign × moon sign × ascendant × house — costs nothing after the first
   occurrence. With whole-sign houses the free tier's key space is small (12⁴ ≈ 20k for the four
   positions, and far fewer in practice), so the free tier converges to a mostly-cached corpus.

### Cost ceilings (decided 2026-11-08)

| Tier | Ceiling per reading | Volume rule |
|---|---|---|
| Free | **≤ 5 MXN** | **one free reading per user, ever** |
| Paid | **≤ 10 MXN** | per reading, within the subscription |

These replace the monthly per-user cap in §9b.6 for the free tier — "one reading" is a cleaner
constraint than "N per month", and it is what makes the free tier cheap: the population of free
readings is bounded by the number of signed-up users, not by their activity.

### Does 5/10 MXN make sense? Rough arithmetic

At today's rates ~5 MXN ≈ US$0.27 and ~10 MXN ≈ US$0.55. A 1,000-word English section is roughly
1,300–1,500 output tokens; a twelve-section paid document therefore lands near **15k output tokens**
plus ~2k input if the digest is not cached. Frontier pricing is on the order of US$10–15 per
million output tokens, so:

- a twelve-section document on a frontier model ≈ US$0.15–0.25 ≈ **3–5 MXN**, and on a
  mid-tier model a fraction of that;
- a two-section free reading ≈ US$0.03–0.05 ≈ **0.5–1 MXN**.

So both ceilings are **comfortable with headroom, not tight** — good. Two consequences worth
recording:

1. **The cheap/strong split matters less than expected.** At 10 MXN you can afford the strong
   model for the whole paid document. Keep the per-section mapping anyway (§9b.1), because it is
   what makes a cost overrun a one-line fix, but do not design around forcing sections onto a
   weak model.
2. **Cache still matters**, not for unit cost but for latency and determinism: a cache hit is
   instant and identical, which is worth more than the cents.
3. **Spanish costs a little more** than English per word for most providers; both budget numbers
   already absorb that, but the corpus test should assert per-locale cost separately.
4. Prices move. The ceiling is expressed in MXN on purpose: the test asserts **cost in currency**,
   computed from a token count × a configured price table, so a provider price change is a config
   edit plus a test failure — not a silent margin leak.

**Free reading = one per user, ever.** Implementation notes for #104/#108: enforce on the *user*
(not the session), make it explicit in the UI ("your free reading"), and make a second request
return the existing reading rather than an error. Abuse control beyond that belongs with #53
(rate limiting) — an email-verified account is the natural unit (see #54).

## 9c. Free-tier size — the recommendation

**Two sections: `overview` + `sun`.** Reasoning:

- The free reading should answer "what is this?" convincingly, not "what is my year?" A year-long
  reading that is fully satisfying removes the reason to buy; a reading that is specific but
  visibly incomplete creates it.
- `lockedSections` can honestly name what exists — the aspects, the houses, the planet-by-planet
  year, the nodes, the profections, the transit picture, the closing synthesis. Nine named
  sections is a stronger incentive than four long ones.
- You can now compute Placidus, natal cross-aspects and transits **only for paid**, so the paid
  tier is not merely "more prose" — it is a *different, more precise chart*. That is a better
  product story than a longer version of the same thing.
- Commercially, the constraint is usually the reverse of the fear: a free reading that is too good
  converts worse than one that ends on a specific, unmet question. Two sections ending on "the
  year's theme" is a natural cliffhanger; four sections ending on the ascendant is a complete
  reading.

This is a testable hypothesis, not a certainty: ship two, measure conversion, and the section
registry makes "add `moon` back to free" a config change rather than a rewrite.

**Cliffhanger is a prompt requirement, not an editorial hope.** The `overview` and `sun` prompts
must instruct the model to end on a specific, chart-grounded, still-open question — and the
section schema carries a `closingQuestion` field so the renderer can present it deliberately rather
than hoping the last paragraph reads that way. #109's review rubric already scores "does the free
tier end on an unmet question"; #104 must add the schema field and #103 the prompt clause.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Generated text is confidently wrong about astrology | Astrologer review gate per `contentVersion`; `facts` stored with every section so a claim can be checked against the chart |
| Cost creep per reading | Paid-only generation, cache, token budget, monthly cap, kill switch |
| Model swap silently degrades prose | Frozen regression corpus, diffed before enabling |
| Provider outage blocks readings | Fail-soft: chart sections always render; narrative shows retry |
| Schema drift across `contentVersion` | Versioned document schema; renderer tolerates unknown blocks |
| Prompt injection via user-supplied strings | No user free-text reaches the prompt; the digest is numeric/enumerated |
| Spanish quality lags English | Review gate is per locale; corpus test asserts both |

## 11. What this explicitly does not do

- No CMS, no editorial tree, no per-sentence authoring UI (§6).
- No rule engine over `knowledge`; the table survives only as an override store.
- No change to `calculateSolarReturn`'s public contract; v2 is additive.
- No Chiron/asteroids in MVP (§9.1).
- No claim of professional-grade accuracy before item 3 lands.
