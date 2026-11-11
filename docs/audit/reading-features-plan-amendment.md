# Reading features — plan amendment

Companion to `reading-features-current-implementation.md` (the verbatim source dump).
This file is the analysis: what the current code already does, where the 7-step plan
contradicts it, and the amended sequence.

Every claim below was checked against the files in `src/`; section references point at
the dump.

---

## 1. Correction to my previous message

I said `hasActiveSubscription()` "does not exist". **Wrong.** What exists is
`hasPremiumAccess(userId)` at `src/lib/auth.ts:29`, and it is already wired into
`currentUser()`, which derives `plan: "paid" | "free"` on every request from
`subscriptions` (status ∈ {active, trialing} AND `grantsAccess` AND
`currentPeriodEnd > now()`).

So the entitlement gate is **not a build step**. There is no `hasActiveSubscription` and
no `getCheckoutUrl` — but there is `hasPremiumAccess` and `POST /api/billing/checkout`
returning `{ url }`. Step 5 of the plan is already done; it just isn't consuming the
document.

Correction to the correction: `hasPremiumAccess` has **zero callers outside `auth.ts`**.
Its only consumer is `currentUser().plan`. That is fine — it means `currentUser()` is the
trusted gate and nothing else should query `subscriptions` for gating.

---

## 2. What is already done and should not be rebuilt

| Plan step | Status | Evidence |
|---|---|---|
| 2. Reading document types | **Done in substance** | `types.ts` — a superset of what the plan specifies. 5 block kinds, `tier`, `facts`, `status`, `failureReason`, `closingQuestion`, plus `lockedSections`, `models`, `costMxn` |
| 3. Reading page reads frozen document | **Not done** | 0 references to `readingDocuments` in `page.tsx` |
| 4. Two-tier renderer | **Not done** | No block renderer exists anywhere. `solar-pdf.tsx` renders notes |
| 5. Entitlement gate | **Done** | `hasPremiumAccess` + `currentUser().plan`; `page.tsx` already branches on it |
| 6. Lazy paid generation | **Not done** | `route.ts:70` hardcodes `tier: "free"`; no route generates a paid document |
| 7. Editorial PDF | **Not done** | `solar-pdf.tsx` takes `ReadingNotes`, cannot see a document |

---

## 3. Where the plan contradicts the code

### 3.1 The provider seam (blocking, step 1)

Plan: `provider.generate(params) → {content, usage:{promptTokens, completionTokens, estimatedCostUsd}}`.

Actual (`provider.ts:23-39`):

```ts
export type CompletionRequest = {
  section: SectionKey; locale: Locale; prompt: string; digest: ChartDigest;
  jsonSchema: Record<string, unknown>; model: string; maxOutputTokens: number;
};
export type Completion = { output: unknown; usage: ProviderUsage; model: string; latencyMs: number };
export type ProviderUsage = { inputTokens: number; outputTokens: number };
export interface ReadingProvider { readonly name: string; complete(request: CompletionRequest): Promise<Completion>; }
```

Three consequences:

- **No cost field, deliberately.** Cost is computed downstream in MXN from
  `config.ts:costMxn(model, usage)`. The plan's `estimatedCostUsd` would introduce a
  second pricing path in a second currency — exactly what `config.ts`'s header comment
  says the design avoids ("expressed in MXN on purpose — the corpus test asserts cost in
  currency, so a provider price change is a config edit plus a test failure, not a silent
  margin leak").
- **The plan's hardcoded `gpt-4o-mini` rates** (`0.00000015` / `0.0000006` per token)
  would under-count a `gpt-4o` call by ~16×, and are meaningless for any non-OpenAI
  endpoint. The ceiling check in `generate.ts` is `spent + 2 * projectedOnce >
  TIER_CEILING_MXN[tier]` — a price that is too low disables the ceiling silently. This
  is the failure mode `#108`/`#129` exist to prevent.
- **`output` is `unknown`, not a string.** The pipeline validates with
  `validateSectionOutput`; an adapter that returns a string will fail every section and
  fall back. A real adapter must `JSON.parse` the model's content and return the object,
  or return the raw string and let validation produce the (correct) error.

### 3.2 The block vocabulary (blocking, step 4)

Plan: `paragraph | heading | bullets | highlight`. Actual: `prose | callout | list |
keyValue | aspectTable` (`types.ts:32-37`), enforced by `schemas.ts:readingBlockSchema`.

A renderer switched on the plan's kinds hits `return null` on every real block and
renders empty sections. Worse, it is silent: no type error, no test failure, blank page.

There is no `heading` kind because headings come from `SECTION_TITLES` /
`SECTION_SUBTITLES`, and no `paragraph` because prose is `{kind:"prose", text}`.

`schemas.ts` also has an explicit forward-compatibility contract the plan's renderer
ignores: *"The renderer (#106) tolerates unknown kinds"*. The renderer's default branch
must render nothing for an unknown kind rather than throw — but it must exhaustively
handle the five known ones.

### 3.3 Tier is a document property, not a per-section computation (design)

Plan: separate `FREE_SECTIONS` / `PAID_SECTIONS` arrays, per-section visibility computed
in a `reading-view.ts` helper.

Actual: `document.tier` + `sectionsForTier()` decide what is even *generated*
(`generate.ts:156`). A free document contains `["overview","sun"]` and nothing else — the
paid sections are not generated, not stored, and not withheld at render time. They appear
only as `lockedSections`, built in `document.ts:135-137`:

```ts
const lockedSections: LockedSection[] = availableSections(digest)
  .filter(key => sectionDefinition(key).tier === "paid" && !attempted.has(key))
  .map(key => ({ key, title: SECTION_TITLES[key][locale], teaser: LOCKED_TEASERS[key][locale] }));
```

The repository's own words, in `types.ts`: **"Paid prose is not generated at all until
entitlement (#107) — 'blurred' means absent."**

So the plan's step 4 ("render free sections fully, blur paid ones") is not implementable
against a free document, because the paid text does not exist. What step 4 actually is:

- render `document.sections` (whatever tier the document has) via the block renderer;
- render `document.lockedSections` as teasers using their pre-written `teaser` strings.

Blur/CSS-filter is only ever appropriate if you decide to generate paid prose for
non-subscribers and hide it in the client — which contradicts both the cost model and the
stated design, and would leak the whole paid product in the page payload.

If a real blur is a product requirement, it needs a decision, not an implementation
detail: pay ~10 MXN per non-subscriber view to have text you can blur, or don't.

### 3.4 `extractTeaser()` duplicates existing copy

Plan slices the first paragraph to 150 chars. `LOCKED_TEASERS` already holds hand-written,
bilingual, per-section teasers (`copy.ts`). Use them. The plan's version also cuts
mid-sentence on real prose.

### 3.5 Step 6 breaks the schema's uniqueness invariant (blocking)

`reading_documents` is unique on `(reading_id, locale, content_version)` — **no `tier`
column** (`schema.ts:54`). And `document.ts:162` `persistableDocument()` plus
`route.ts:79` `.onConflictDoNothing()` make the table freeze-once.

Therefore a lazy "generate the paid document now" route **cannot insert** a paid document
for an existing free reading at the same content version: the insert no-ops and the
handler silently returns the free row's id. Two of the three possible fixes are wrong:

- ❌ `UPDATE` the frozen row — violates "there is no update path; immutability is
  structural" and destroys the record of what the reader actually paid for.
- ❌ `.onConflictDoUpdate` — same thing with extra steps.
- ⚠️ Change the unique key to include `tier` — a migration touching an invariant the
  corpus test asserts (`readings-db.test.ts`). Defensible, but it's a schema decision with
  prod-migration consequences (ADR 008: migrate before deploy).
- ✅ **Bump `contentVersion` for the paid document** — but note `contentVersion` is a hash
  of prompts + schemas + model policy (`content-version.ts`), and `computeContentVersion`
  is memoized per process. A paid document at the same code state has the *same*
  contentVersion as the free one. So "bump it" means introducing a tier discriminator
  into the version computation (e.g. `policy.tier`), which changes every existing
  document's version on the next generation run.

That last point is why step 6 is not an afternoon: the cheapest correct fix touches
`content-version.ts`, which invalidates the `generation_cache` keys for **every** reading,
which means the next generation of any reading re-dispatches instead of hitting cache. On
a paid tier that is 9 sections of real spend per reading.

**Recommendation:** decide the paid-document storage question *before* writing step 6, and
prefer an explicit `tier` in the unique key + a `policy.tier` in contentVersion, landed as
one migration. Do not let step 6 discover this.

### 3.6 `generate.ts` has no paid-tier entry point, and shouldn't get one naively

`wanted` is computed from `sectionsForTier(args.tier)` then filtered by
`availableSections`. For `tier:"paid"`, `wanted` = 9 sections (corpus test asserts this:
`document.sections.length === 9`). Running that synchronously inside a request is 9
sequential provider calls with a repair path each.

The pipeline is *correct* for this but has no timeout, no background execution, and no
job queue. `POST /api/readings` already calls it inline for 2 sections. Doing it for 9 in
a serverless request will hit the platform's function timeout on a slow provider, leaving
the reader with a free document and a logged error — the failure mode is graceful
(`generate.ts` never throws) but the paid content never arrives and the user has already
been charged.

This is the strongest argument for doing step 6 **last** and giving it a job/queue or a
publish-later model rather than a request-scoped loop.

### 3.7 The PDF needs a new signature, not a patch

`SolarReturnDocument({input, result, notes, locale, premium, renderer})` — `notes` is
`ReadingNotes`, 4 strings from the `knowledge` table. The plan's "full editorial PDF"
needs `document: ReadingDocument`. That means:

- widening the signature (keep `notes` while the page still uses it),
- a block → `<View>` renderer for `@react-pdf/renderer` (separate from the HTML one —
  `<Text>`/`<View>` primitives, no `dangerouslySetInnerHTML`, no Tailwind),
- `tests/pdf.test.ts` (18 lines) asserts the current free/premium editions still render.

Two renderers, two primitives, one block vocabulary. Budget for both; do not assume the
HTML renderer can be reused.

### 3.8 Factual details worth fixing while you're in there

- `provider.ts:85` `bodyLine()` is **dead code** — defined, never called.
- `docs/backlog-review-2026-11-10.md:62` and the audit say generation will work once a
  provider is configured. `resolveProvider()` returns `null` for any unknown name, so
  `READINGS_PROVIDER=openai` today silently yields `provider_unavailable` for every
  section. That is the documented behaviour, but "one config step" (my earlier phrasing,
  from the plan) understates it: it's one config step *after* an adapter exists.
- `.env.example:49-57` already lists all five `READINGS_*` variables, including
  `READINGS_CHEAP_MODEL` / `READINGS_STRONG_MODEL` — the adapter must honour both, since
  `SECTION_MODEL_TIER` routes 10 sections to cheap and `guidance` to strong.
- `costMxn` in the DB is `doublePrecision`; `document.ts` rounds to 6 dp. Fine, but note
  the corpus test asserts `document.costMxn > 0` — a real model priced at near-zero
  (e.g. a free-tier endpoint) would fail that assertion. The price table needs plausible
  non-zero MXN rates.

---

## 4. Amended sequence

Six steps. Each is independently testable; each leaves the app shippable with generation
off.

### Step 0 — Decide two things (no code)

1. **Paid-document storage:** add `tier` to the unique index + `policy.tier` to
   contentVersion (one migration, cache invalidation), or accept that a paid document
   always supersedes the free one at a new content version. Everything in step 5 depends
   on this.
2. **Blur or absent:** render `lockedSections` teasers (cheap, matches design), or
   generate paid prose for everyone (costly, contradicts `types.ts` and the ceilings).

### Step 1 — Real provider adapter (`src/readings/adapters/<vendor>.ts`, ~1 day)

Implements `ReadingProvider`: `complete(request): Promise<Completion>`.

- Use `request.prompt` as given (the wrapper already embeds brief + digest + schema);
  `request.jsonSchema` only if the vendor supports structured output, otherwise rely on
  validation + the single repair.
- Return `output` as **parsed JSON** where possible; return the raw string on a parse
  failure so `validateSectionOutput` produces the real error.
- Return `usage` from the vendor's own token counts; never estimate, because
  `validUsage` + `costMxn` are the ceiling ledger's only inputs. If the vendor omits
  usage, throw — the pipeline's `provider_error` path is the honest outcome.
- Register in `PROVIDERS` (`provider.ts:266`). Do not touch the interface.
- Price it in `READINGS_MODEL_PRICES` with real MXN per million, covering **both**
  `READINGS_CHEAP_MODEL` and `READINGS_STRONG_MODEL`.
- Tests: a fake HTTP layer asserting prompt passthrough, JSON parse, usage mapping, and
  an unpriced model halting the run (`runHalted` — already covered by
  `readings-pipeline.test.ts`; add the adapter to it rather than new scaffolding).

**Gate (the plan's Day-1 gate, kept):** generate one real reading for one chart, both
locales, and read it. Compare against `createFixtureProvider()` output for the same
digest. If it is worse than the fixture, stop and fix prompts — everything downstream
renders whatever this produces.

### Step 2 — Block renderer (`src/components/reading-blocks.tsx`, ~half day)

Pure, presentation-only, takes `blocks: ReadingBlock[]`:

- exhaustive switch on the five kinds;
- unknown kind → `null` (the contract in `schemas.ts`);
- no tier logic, no data fetching, no document access.

Renders `status: "failed"` too: show `FALLBACK_PROSE` + the `keyValue` facts block that
`fallbackBlocks()` already builds. Today nothing surfaces `failureReason`; a reader would
silently see less content.

Tests: one render test per kind plus unknown-kind-is-null.

### Step 3 — Reader page reads the frozen document (~1 day)

`page.tsx`:

- after loading the reading, query `readingDocuments` for this `readingId` + `locale`,
  newest `contentVersion`;
- **if a document exists**, render its `sections` with the step-2 renderer, then
  `lockedSections` as teasers (`title` + `teaser` + `LOCKED_CTA` — currently defined and
  never rendered);
- **if not**, fall back to today's `getReadingNotes()` panels (generation is off by
  default, so most readings have no document, and a missing document must never blank the
  page);
- keep the `AstroWheel`, placement cards, disclaimers, and `DeleteReading` exactly as-is.

No entitlement branch is added here — `currentUser().plan` already selects what the
document contains. The page's own `user.plan === "paid"` teaser panel is removed once
documents exist, because the document's `lockedSections` is the same information from the
right source.

Tests: page-level — document present (free tier), document absent (fallback), document
with a `failed` section.

### Step 4 — Editorial PDF (~1–2 days)

- widen `SolarReturnDocument` to accept `document?: ReadingDocument`;
- add a `<View>`/`<Text>` block renderer beside the HTML one;
- free tier: cover + placements + the document's free sections + locked-section teasers;
- paid tier: every section;
- keep the `premium` flag consistent with `currentUser().plan`;
- PDF route: query the document, pass it through, fall back to `notes` when absent.

`tests/pdf.test.ts` must keep passing for the notes-only path — that path stays live for
readings generated before the flag was on.

### Step 5 — Lazy paid generation (last, ~2 days + infra decision)

Only after step 0's decision. Requirements, in order:

- trigger after `hasPremiumAccess` is **true** server-side (never from a client claim);
- write at a content version that cannot collide with the free row (per step 0);
- do not run 9 sections inside a request that a reader is waiting on — either a job, or
  generate-behind-the-page with a "your full reading is being written" state;
- respect `TIER_CEILING_MXN.paid` (10 MXN) — 9 sections through a strong model will
  exceed it without careful cheap/strong routing;
- an existing document is never rewritten; a second run must be idempotent.

### Step 6 — Turn it on

`READINGS_GENERATION_ENABLED=true`, `READINGS_PROVIDER=<vendor>`, both model ids, and a
price table covering them. Add the consent gate (`#105`) before the flag flips — the
route comment already marks the slot: *"The consent gate (#105) slots in here before any
flag flip."*

---

## 5. Cost note

The fixture is priced at 15 / 60 MXN per million (in/out) and the corpus test asserts the
free tier comes in under 5 MXN. Two real-model facts to settle in step 1:

- `MAX_OUTPUT_TOKENS_PER_SECTION = 2_000`, and the pre-dispatch projection charges
  `2 × (prompt + 2_000 output tokens)`. With a strong model, that projection alone can
  exceed the 10 MXN paid ceiling and the section is refused before dispatch — the symptom
  is `failureReason: "cost_ceiling"`, not an error. Check the arithmetic against real
  prices before assuming 9 paid sections fit.
- The plan's USD pricing would have made that check pass when it should fail.

---

## 6. One-paragraph version

The pipeline is finished and well-tested; the plan is building the parts that already
exist (document types, entitlement) and the wrong shape of the part that doesn't (the
provider seam, the block vocabulary, tier gating, paid-document storage). Real order:
adapter → block renderer → page reads the document → PDF → paid generation (after a
storage decision) → enable.
