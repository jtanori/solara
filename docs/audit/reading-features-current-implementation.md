# Reading features — current implementation, verbatim

Snapshot of `arena/f6390472-solara` at `dd8d707` (branched from `e030672` on `staging`).

**Fidelity note.** Most files below are reproduced verbatim. Five are not, and each
says so inline:

| File | What was omitted |
|---|---|
| `provider.ts` | the `houses` / `planets` / `nodes` / `guidance` fixture bodies (~100 lines) |
| `generate.ts` | reproduced as an annotated control-flow outline, not verbatim |
| `db-cache.ts` | both method bodies elided as `/* ... */` |
| `route.ts` (save) | imports collapsed to `/* ... */`, error branches elided |
| `page.tsx`, `solar-pdf.tsx` | summarised structurally (each is 1–3 giant JSX lines) |

The repo-root script `dump-readings.sh` emits **all** of it verbatim — run
`./dump-readings.sh > /tmp/readings.md` for the complete text. If a line here disagrees
with the file, the file wins.

**Part 1** (this file, §§1.1–1.10) is the source. **Part 2**
(`docs/audit/reading-features-plan-amendment.md`) is the analysis: what works, what the
build plan contradicts, and the amended sequence.

---

## 2. What exists today, in one table

Nine modules plus five app surfaces. The pipeline is genuinely complete; the gap is
entirely at the edges — no real provider, no reader, no editorial PDF.

| Layer | File | Lines | State |
|---|---|---|---|
| Domain model | `src/readings/types.ts` | 81 | Complete. Array of sections, 5 block kinds, `lockedSections` |
| Section registry | `src/readings/registry.ts` | 63 | Complete. 11 sections, 2 free / 9 paid, tier is config |
| Output contracts | `src/readings/schemas.ts` | 93 | Complete. Strict Zod → JSON Schema, cliffhanger enforced |
| Configuration | `src/readings/config.ts` | 126 | Complete. Prices in MXN, ceilings free ≤5 / paid ≤10 |
| Copy | `src/readings/copy.ts` | 65 | Complete. Titles, subtitles, teasers, fallbacks, CTA — both locales |
| Versioning | `src/readings/content-version.ts` | 80 | Complete. Hashes prompts + schemas + model policy |
| Provider | `src/readings/provider.ts` | 268 | **Fixture only.** `PROVIDERS` has exactly one entry |
| Assembly | `src/readings/document.ts` | 167 | Complete. Pure; never dispatches |
| Pipeline | `src/readings/generate.ts` | 443 | Complete. Cache, ceiling, repair, halt, fallback |
| Cache | `src/readings/db-cache.ts` | 51 | Complete. Insert-only |
| Save route | `src/app/api/readings/route.ts` | 96 | Writes a **free** document, behind a flag |
| PDF route | `src/app/api/readings/[id]/pdf/route.ts` | 23 | **Summary only.** Ignores `reading_documents` |
| PDF layout | `src/components/solar-pdf.tsx` | 40 | **3 pages**, from `knowledge` notes, not the document |
| Reader page | `src/app/reading/[id]/page.tsx` | 25 | **Never reads `reading_documents`** |
| Entitlement | `src/lib/auth.ts:29` | 50 | **`hasPremiumAccess` already exists** |

---

## 1. Verbatim source

Every line below is the file as it exists at commit `dd8d707` on `arena/f6390472-solara`. Nothing has been edited or trimmed.

## 1.1 Domain model and contracts

### `src/readings/types.ts`

Lines: 81 · bytes: 2970

```ts
import type { Locale } from "@/lib/i18n";

/**
 * The reading document domain model (`docs/plan-readings-engine-epic.md` §2).
 *
 * The persisted unit is a document of typed sections: the *facts* are computed
 * deterministically and stored on the reading; the *prose* is generated once
 * against a strict schema and then frozen. Paid prose is not generated at all
 * until entitlement (#107) — "blurred" means absent.
 */

export type SectionTier = "free" | "paid";
export type SectionStatus = "generated" | "overridden" | "failed";

/** Stable section ids (§2). `planetaryYear` and `transits` await engine facts (#110). */
export const SECTION_KEYS = [
  "overview",
  "sun",
  "moon",
  "ascendant",
  "aspects",
  "houses",
  "planets",
  "nodes",
  "planetaryYear",
  "transits",
  "guidance",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/** Ordered content blocks. The renderer (#106) tolerates unknown kinds. */
export type ReadingBlock =
  | { kind: "prose"; text: string }
  | { kind: "callout"; title?: string; text: string }
  | { kind: "list"; title?: string; items: string[] }
  | { kind: "keyValue"; title?: string; entries: { key: string; value: string }[] }
  | { kind: "aspectTable"; title?: string; rows: { a: string; b: string; type: string; orb: number }[] };

export type ReadingSection = {
  key: SectionKey;
  tier: SectionTier;
  title: string;
  subtitle?: string;
  blocks: ReadingBlock[];
  /** The chart facts this section is grounded in (for review + regeneration). */
  facts: Record<string, unknown>;
  status: SectionStatus;
  /** Set when status is "failed": why the fallback copy is showing. */
  failureReason?: string;
  /** The section's closing open question (required for the free cliffhanger sections). */
  closingQuestion?: string;
};

export type LockedSection = {
  key: SectionKey;
  title: string;
  teaser: string;
};

export type ReadingDocument = {
  id: string;
  readingId: string;
  locale: Locale;
  chartVersion: string;
  contentVersion: string;
  /** Provenance per generated word: model per section. */
  models: Partial<Record<SectionKey, string>>;
  generatedAt: string;
  tier: SectionTier;
  sections: ReadingSection[];
  lockedSections: LockedSection[];
  /**
   * Cost accounting, asserted against the tier ceiling: costMxn is the spend
   * that produced the published sections (cache hits add 0); wastedCostMxn is
   * spend on attempts that produced nothing (failed primaries, repairs, and
   * post-ceiling discards). Honest accounting records both.
   */
  costMxn: number;
  wastedCostMxn: number;
};
```

### `src/readings/registry.ts`

Lines: 63 · bytes: 2921

```ts
import type { ChartDigest } from "@/lib/chart";
import type { SectionKey, SectionTier } from "@/readings/types";
import { SECTION_MODEL_TIER, type ModelTier } from "@/readings/config";

/**
 * The section registry (`docs/plan-readings-engine-epic.md` §2, §6) — the
 * editable surface for *structure*. A new section is a registry entry plus a
 * prompt file plus a schema: no migration, no CMS. Tiers are configuration:
 * free = `overview` + `sun` (decision 6, §9c — the conversion/cost lever,
 * cheap to change).
 */

export type SectionDefinition = {
  key: SectionKey;
  tier: SectionTier;
  modelTier: ModelTier;
  /**
   * Engine facts this section is grounded in. A section whose facts are not
   * (yet) carried by the digest is not generatable — ungrounded prose is the
   * "confidently wrong" risk (§10), so the registry refuses to dispatch it.
   * `planetaryYear` needs profections and `transits` needs transit-to-natal
   * aspects: both land with #110, which extends the digest, and these entries
   * light up without any registry change.
   */
  requiresFacts?: "profections" | "transits";
};

export const SECTION_REGISTRY: Record<SectionKey, SectionDefinition> = {
  overview: { key: "overview", tier: "free", modelTier: SECTION_MODEL_TIER.overview },
  sun: { key: "sun", tier: "free", modelTier: SECTION_MODEL_TIER.sun },
  moon: { key: "moon", tier: "paid", modelTier: SECTION_MODEL_TIER.moon },
  ascendant: { key: "ascendant", tier: "paid", modelTier: SECTION_MODEL_TIER.ascendant },
  aspects: { key: "aspects", tier: "paid", modelTier: SECTION_MODEL_TIER.aspects },
  houses: { key: "houses", tier: "paid", modelTier: SECTION_MODEL_TIER.houses },
  planets: { key: "planets", tier: "paid", modelTier: SECTION_MODEL_TIER.planets },
  nodes: { key: "nodes", tier: "paid", modelTier: SECTION_MODEL_TIER.nodes },
  planetaryYear: { key: "planetaryYear", tier: "paid", modelTier: SECTION_MODEL_TIER.planetaryYear, requiresFacts: "profections" },
  transits: { key: "transits", tier: "paid", modelTier: SECTION_MODEL_TIER.transits, requiresFacts: "transits" },
  guidance: { key: "guidance", tier: "paid", modelTier: SECTION_MODEL_TIER.guidance },
};

/** Sections whose grounding facts the digest actually carries. */
export function availableSections(digest: ChartDigest): SectionKey[] {
  const carried = digest as unknown as Record<string, unknown>;
  return (Object.keys(SECTION_REGISTRY) as SectionKey[]).filter(key => {
    const required = SECTION_REGISTRY[key].requiresFacts;
    return !required || carried[required] !== undefined;
  });
}

/**
 * Sections a document of `tier` contains: the free tier gets its free sections
 * only; the paid tier gets everything (paid readers keep the free sections).
 */
export function sectionsForTier(tier: SectionTier): SectionKey[] {
  return (Object.keys(SECTION_REGISTRY) as SectionKey[]).filter(
    key => tier === "paid" || SECTION_REGISTRY[key].tier === tier,
  );
}

export function sectionDefinition(key: SectionKey): SectionDefinition {
  return SECTION_REGISTRY[key];
}
```

### `src/readings/schemas.ts`

Lines: 93 · bytes: 3095

```ts
import { z } from "zod";
import type { ReadingBlock } from "@/readings/types";
import type { SectionKey } from "@/readings/types";

/**
 * Strict per-section output contracts (`docs/plan-readings-engine-epic.md` §4.3).
 *
 * One shared block vocabulary; every field is typed, every object is closed
 * (`additionalProperties: false` in the exported JSON Schema), and the free
 * sections additionally *require* a closing question — the cliffhanger clause
 * (§9c) is enforced by the schema, not by hope. The renderer (#106) treats
 * unknown block kinds as absent, so this vocabulary can grow without a
 * coordinated deploy.
 */

const text = z.string().min(1).max(4_000);
const title = z.string().min(1).max(200).optional();

const proseBlock = z.strictObject({ kind: z.literal("prose"), text });
const calloutBlock = z.strictObject({ kind: z.literal("callout"), title, text });
const listBlock = z.strictObject({ kind: z.literal("list"), title, items: z.array(text).min(1).max(20) });
const keyValueBlock = z.strictObject({
  kind: z.literal("keyValue"),
  title,
  entries: z.array(z.strictObject({ key: text, value: text })).min(1).max(20),
});
const aspectTableBlock = z.strictObject({
  kind: z.literal("aspectTable"),
  title,
  rows: z
    .array(z.strictObject({ a: text, b: text, type: text, orb: z.number().min(0).max(30) }))
    .min(1)
    .max(100),
});

export const readingBlockSchema = z.discriminatedUnion("kind", [
  proseBlock,
  calloutBlock,
  listBlock,
  keyValueBlock,
  aspectTableBlock,
]);

/** Sections whose output must end with the cliffhanger question (§9c). */
const CLIFFHANGER_SECTIONS: readonly SectionKey[] = ["overview", "sun"];

export type SectionOutput = {
  blocks: ReadingBlock[];
  closingQuestion?: string;
};

function buildSectionSchema(key: SectionKey) {
  return z.strictObject({
    blocks: z.array(readingBlockSchema).min(1).max(30),
    closingQuestion: CLIFFHANGER_SECTIONS.includes(key) ? z.string().min(10).max(500) : z.string().min(1).max(500).optional(),
  });
}

const sectionSchemas = new Map<SectionKey, z.ZodType<SectionOutput>>();
export function sectionSchema(key: SectionKey): z.ZodType<SectionOutput> {
  let schema = sectionSchemas.get(key);
  if (!schema) {
    schema = buildSectionSchema(key);
    sectionSchemas.set(key, schema);
  }
  return schema;
}

const jsonSchemas = new Map<SectionKey, Record<string, unknown>>();
/** Draft 2020-12 JSON Schema for a section, memoized — this is what the provider validates against. */
export function sectionJsonSchema(key: SectionKey): Record<string, unknown> {
  let json = jsonSchemas.get(key);
  if (!json) {
    json = z.toJSONSchema(sectionSchema(key)) as Record<string, unknown>;
    jsonSchemas.set(key, json);
  }
  return json;
}

export type SectionValidation =
  | { ok: true; value: SectionOutput }
  | { ok: false; error: string };

/** Validate raw provider output. Never throws — the repair path needs the reason. */
export function validateSectionOutput(key: SectionKey, data: unknown): SectionValidation {
  const result = sectionSchema(key).safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map(issue => {
    const path = issue.path.length ? `/${issue.path.join("/")}` : "";
    return `${path}: ${issue.message} (${issue.code})`;
  });
  return { ok: false, error: `schema validation failed for section "${key}":\n${issues.join("\n")}` };
}
```

## 1.2 Configuration, copy, versioning

### `src/readings/config.ts`

Lines: 126 · bytes: 4851

```ts
/**
 * Generation configuration (`docs/plan-readings-engine-epic.md` §4 rules, §9b mechanics).
 *
 * Everything here is configuration, not code paths sprinkled through the app:
 * the kill switch, the model-per-section mapping, the price table and the
 * per-tier cost ceilings. The ceiling is expressed in MXN on purpose — the
 * corpus test asserts cost in currency, so a provider price change is a config
 * edit plus a test failure, not a silent margin leak.
 */

export type ModelTier = "cheap" | "strong";

export type ModelPrice = {
  /** MXN per million input tokens. */
  inputMxnPerMillion: number;
  /** MXN per million output tokens. */
  outputMxnPerMillion: number;
};

/** Cost ceilings (§9b, decided 2026-11-08): free ≤ 5 MXN, paid ≤ 10 MXN. */
export const TIER_CEILING_MXN: Record<"free" | "paid", number> = {
  free: 5,
  paid: 10,
};

/** Upper bound on output tokens per dispatch, enforced before dispatch. */
export const MAX_OUTPUT_TOKENS_PER_SECTION = 2_000;

/**
 * Default price table. The fixture provider is priced mid-tier so cost
 * accounting is exercised with non-trivial numbers; real models get real
 * prices here (or via READINGS_MODEL_PRICES as JSON) when the provider
 * decision lands (§9b).
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  "fixture-1": { inputMxnPerMillion: 15, outputMxnPerMillion: 60 },
};

function validPrice(entry: unknown): entry is ModelPrice {
  if (typeof entry !== "object" || entry === null) return false;
  const { inputMxnPerMillion, outputMxnPerMillion } = entry as Record<string, unknown>;
  return (
    typeof inputMxnPerMillion === "number" && Number.isFinite(inputMxnPerMillion) && inputMxnPerMillion >= 0 &&
    typeof outputMxnPerMillion === "number" && Number.isFinite(outputMxnPerMillion) && outputMxnPerMillion >= 0
  );
}

/**
 * The active price table. Unset ⇒ defaults. Set ⇒ the env is authoritative
 * (it REPLACES the defaults). Set-but-invalid ⇒ null, and every caller treats
 * null as "do not dispatch": an unpriceable model must never be priced at
 * 0 MXN and silently bypass the ceilings.
 */
export function modelPrices(): Record<string, ModelPrice> | null {
  const raw = process.env.READINGS_MODEL_PRICES;
  if (!raw) return DEFAULT_MODEL_PRICES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (!validPrice(entry)) return null;
    }
    return parsed as Record<string, ModelPrice>;
  } catch {
    return null;
  }
}

/** Price of one model, or null when unpriced — callers must fail closed on null. */
export function priceFor(model: string): ModelPrice | null {
  return modelPrices()?.[model] ?? null;
}

/** Section → model tier (§9b.1). Short formulaic sections are cheap; synthesis is strong. */
export const SECTION_MODEL_TIER: Record<string, ModelTier> = {
  overview: "cheap",
  sun: "cheap",
  moon: "cheap",
  ascendant: "cheap",
  aspects: "cheap",
  houses: "cheap",
  planets: "cheap",
  nodes: "cheap",
  planetaryYear: "cheap",
  transits: "cheap",
  guidance: "strong",
};

/** Model id per tier — configuration, not an import (the adapter owns the call). */
export function modelForTier(tier: ModelTier): string {
  if (tier === "strong") return process.env.READINGS_STRONG_MODEL ?? "fixture-1";
  return process.env.READINGS_CHEAP_MODEL ?? "fixture-1";
}

/** The global kill switch: one flag disables generation, chart-only remains. */
export function generationEnabled(): boolean {
  return process.env.READINGS_GENERATION_ENABLED === "true";
}

/** Provider selection. Unset or unknown ⇒ generation cannot run (fails soft). */
export function providerName(): string | null {
  return process.env.READINGS_PROVIDER ?? null;
}

/**
 * MXN cost of a completion, or null when the model is unpriced. Null is the
 * fail-closed signal: callers skip dispatch / discard output rather than
 * record a 0 MXN cost that was never real.
 */
export function costMxn(model: string, usage: { inputTokens: number; outputTokens: number }): number | null {
  const price = priceFor(model);
  if (!price) return null;
  // Defensive invariant: costMxn never returns NaN or a negative number.
  // Non-finite or negative usage is unpriceable (null), same as an unpriced
  // model — callers fail closed on both.
  if (
    !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens) ||
    usage.inputTokens < 0 || usage.outputTokens < 0
  ) {
    return null;
  }
  return (
    (usage.inputTokens / 1_000_000) * price.inputMxnPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputMxnPerMillion
  );
}
```

### `src/readings/copy.ts`

Lines: 65 · bytes: 5334

```ts
import type { Locale } from "@/lib/i18n";
import type { SectionKey } from "@/readings/types";

/**
 * Localized structural copy: section titles, locked-section teasers, and the
 * graceful-fallback text shown when a section could not be generated (kill
 * switch, provider failure, ceiling). Code-based dictionaries per the repo's
 * i18n convention (src/lib/i18n.ts). Presentation polish is #104's; the words
 * here must merely be honest and stable.
 */

export type LocalizedText = Record<Locale, string>;

export const SECTION_TITLES: Record<SectionKey, LocalizedText> = {
  overview: { en: "The Year in One Breath", es: "El año en un solo aliento" },
  sun: { en: "The Sun: Your Birthday Star", es: "El Sol: tu estrella de cumpleaños" },
  moon: { en: "The Moon: Emotional Weather", es: "La Luna: el clima emocional" },
  ascendant: { en: "The Ascendant: The Year's Lens", es: "El Ascendente: el lente del año" },
  aspects: { en: "Aspects: Tensions and Gifts", es: "Aspectos: tensiones y regalos" },
  houses: { en: "Houses: Where the Year Lives", es: "Casas: dónde se vive el año" },
  planets: { en: "Planets: The Cast of the Year", es: "Planetas: el reparto del año" },
  nodes: { en: "The Nodes: Direction of Growth", es: "Los Nodos: dirección de crecimiento" },
  planetaryYear: { en: "The Planetary Year", es: "El año planetario" },
  transits: { en: "Transits: Dates That Matter", es: "Tránsitos: fechas que importan" },
  guidance: { en: "Guidance: Living the Year Well", es: "Guía: vivir bien el año" },
};

export const SECTION_SUBTITLES: Record<SectionKey, LocalizedText> = {
  overview: { en: "What this solar return year is about", es: "De qué va este año de revolución solar" },
  sun: { en: "Where your vitality concentrates", es: "Dónde se concentra tu vitalidad" },
  moon: { en: "The inner climate of the year", es: "El clima interior del año" },
  ascendant: { en: "The attitude you wear into the year", es: "La actitud con la que entras al año" },
  aspects: { en: "The geometry between who you are and who you are becoming", es: "La geometría entre quien eres y en quién te conviertes" },
  houses: { en: "The rooms of life holding the action", es: "Las habitaciones de la vida con la acción" },
  planets: { en: "Every body in its return sign and house", es: "Cada cuerpo en su signo y casa de revolución" },
  nodes: { en: "The compass needle, honestly priced", es: "La aguja de brújula, con su costo" },
  planetaryYear: { en: "The planet holding the year's chair", es: "El planeta que ocupa la silla del año" },
  transits: { en: "The calendar inside the sky", es: "El calendario dentro del cielo" },
  guidance: { en: "Synthesis and practice", es: "Síntesis y práctica" },
};

/** Teasers for locked (paid, not in this document) sections — static copy, no LLM. */
export const LOCKED_TEASERS: Record<SectionKey, LocalizedText> = {
  overview: { en: "The year's headline, written for your chart.", es: "El titular del año, escrito para tu carta." },
  sun: { en: "Your birthday star and where it shines.", es: "Tu estrella de cumpleaños y dónde brilla." },
  moon: { en: "The emotional weather you'll live in.", es: "El clima emocional en el que vivirás." },
  ascendant: { en: "The lens you wear into the year.", es: "El lente con el que entras al año." },
  aspects: { en: "The year's tightest dialogues, named.", es: "Los diálogos más exactos del año, con nombre." },
  houses: { en: "The map of where the action happens.", es: "El mapa de dónde ocurre la acción." },
  planets: { en: "The cast running this year's show.", es: "El reparto que dirige la función de este año." },
  nodes: { en: "The direction of growth — and its price.", es: "La dirección de crecimiento, y su precio." },
  planetaryYear: { en: "The one planet that rules your year.", es: "El planeta que gobierna tu año." },
  transits: { en: "The dates worth circling.", es: "Las fechas que vale la pena marcar." },
  guidance: { en: "How to walk the year, concretely.", es: "Cómo caminar el año, en concreto." },
};

export const FALLBACK_PROSE: LocalizedText = {
  en: "This section of your reading couldn't be written just now. Your chart is safe and the facts below are real — the words will catch up.",
  es: "Esta parte de tu lectura no pudo escribirse por ahora. Tu carta está a salvo y los datos de abajo son reales — las palabras alcanzarán al cielo.",
};

export const LOCKED_CTA: LocalizedText = {
  en: "Unlock the full reading",
  es: "Desbloquea la lectura completa",
};
```

### `src/readings/content-version.ts`

Lines: 80 · bytes: 2692

```ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SECTION_KEYS } from "@/readings/types";
import { sectionJsonSchema } from "@/readings/schemas";
import { MAX_OUTPUT_TOKENS_PER_SECTION, modelForTier, SECTION_MODEL_TIER, TIER_CEILING_MXN } from "@/readings/config";

/**
 * contentVersion (`docs/plan-readings-engine-epic.md` §4.5) — the version stamp
 * on everything a generated word depends on: prompt files, output schemas, the
 * model-per-section tiering, and the resolved model ids (model swaps change
 * content as surely as prompt edits do). Bump POLICY_REVISION when a *code*
 * policy changes (validation rules, repair policy, prompt assembly in
 * generate.ts)
 */

const PROMPTS_DIR = path.join(process.cwd(), "src", "readings", "prompts");
const POLICY_REVISION = "1";

/** Deterministic per the epic: hash of prompts, schemas and the model policy. */
export function contentVersionFromSources(
  promptFiles: Record<string, string>,
  schemas: Record<string, unknown>,
  policy: Record<string, unknown>,
): string {
  const canonical = JSON.stringify({
    promptFiles: Object.fromEntries(Object.keys(promptFiles).sort().map(k => [k, promptFiles[k]])),
    schemas: Object.fromEntries(Object.keys(schemas).sort().map(k => [k, schemas[k]])),
    policy,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function policyJson(): Record<string, unknown> {
  return {
    policyRevision: POLICY_REVISION,
    maxOutputTokensPerSection: MAX_OUTPUT_TOKENS_PER_SECTION,
    ceilings: TIER_CEILING_MXN,
    modelTiering: SECTION_MODEL_TIER,
    models: { cheap: modelForTier("cheap"), strong: modelForTier("strong") },
  };
}

let cached: string | undefined;
export function computeContentVersion(): string {
  if (cached) return cached;
  const files = readdirSync(PROMPTS_DIR).filter(file => file.endsWith(".md"));
  const promptFiles: Record<string, string> = {};
  for (const file of files) promptFiles[file] = readFileSync(path.join(PROMPTS_DIR, file), "utf8");
  const schemas: Record<string, Record<string, unknown>> = {};
  for (const key of SECTION_KEYS) schemas[key] = sectionJsonSchema(key);
  cached = contentVersionFromSources(promptFiles, schemas, policyJson());
  return cached;
}

/** Test seam: forget the memoized value so changed sources change the version. */
export function resetContentVersionCacheForTests(): void {
  cached = undefined;
}
```

## 1.3 Provider adapter and document assembly

### `src/readings/provider.ts`

Lines: 268 · bytes: 14925

```ts
import type { ChartDigest } from "@/lib/chart";
import { signName, type Locale } from "@/lib/i18n";
import type { SectionKey } from "@/readings/types";
import type { SectionOutput } from "@/readings/schemas";

/**
 * The provider adapter (`docs/plan-readings-engine-epic.md` §4.4, §9b) — the
 * single seam between the pipeline and any language model. The model is
 * configuration passed in; nothing here imports an SDK. The fixture provider
 * proves the whole machinery deterministically (corpus tests run against it);
 * a real adapter is a later, config-selected drop-in.
 */

export type ProviderUsage = { inputTokens: number; outputTokens: number };

export type CompletionRequest = {
  section: SectionKey;
  locale: Locale;
  /** Fully assembled prompt (wrapper + brief + digest + schema). */
  prompt: string;
  digest: ChartDigest;
  jsonSchema: Record<string, unknown>;
  /** Chosen by configuration in generate.ts; the provider answers with this model. */
  model: string;
  maxOutputTokens: number;
};

export type Completion = {
  /** Raw model output — untrusted, validated by the caller. */
  output: unknown;
  usage: ProviderUsage;
  model: string;
  latencyMs: number;
};

export interface ReadingProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * A provider's reported usage is untrusted input like any other: token counts
 * must be finite, non-negative numbers. NaN slips past `!== null` checks and
 * poisons every downstream `spent > ceiling` comparison into `false`
 * (NaN > x is false), silently disabling both ceilings; negative counts would
 * let one attempt offset another's spend.
 */
export function validUsage(usage: ProviderUsage): boolean {
  return (
    Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens) &&
    usage.inputTokens >= 0 && usage.outputTokens >= 0
  );
}

// ------------------------------------------------------------------ fixture

const ASPECT_ES: Record<string, string> = {
  conjunction: "conjunción",
  sextile: "sextil",
  square: "cuadratura",
  trine: "trígono",
  opposition: "oposición",
};

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function house(locale: Locale, n: number | null): string {
  if (n === null) return locale === "es" ? "una casa sin asignar (carta polar)" : "an unassigned house (polar chart)";
  return locale === "es" ? `la casa ${n}` : `the ${ordinal(n)} house`;
}

function aspectType(type: string, locale: Locale): string {
  return locale === "es" ? ASPECT_ES[type] ?? type : type;
}

/** A body line like "Sun in Leo, 12.3°, 5th house, retrograde". */
function bodyLine(digest: ChartDigest, body: string, locale: Locale): string {
  const found = digest.bodies.find(b => b.body === body);
  if (!found) return `${body}`;
  const sign = signName(found.sign, locale);
  const retro = found.retrograde ? (locale === "es" ? ", retrógrado" : ", retrograde") : "";
  return locale === "es"
    ? `${body} en ${sign} a ${found.degree}° en ${house(locale, found.house)}${retro}`
    : `${body} in ${sign} at ${found.degree}° in ${house(locale, found.house)}${retro}`;
}

function tightest(digest: ChartDigest): ChartDigest["crossAspects"][number] | undefined {
  return digest.crossAspects.slice().sort((a, b) => a.orb - b.orb)[0];
}

/**
 * Deterministic, schema-valid section content built straight from the digest —
 * the fixture "model". It is deliberately chart-grounded: every sentence cites
 * real facts, so downstream grounding checks would not starve.
 */
function fixtureSection(section: SectionKey, locale: Locale, digest: ChartDigest): SectionOutput {
  const es = locale === "es";
  const sun = `${signName(digest.sun.sign, locale)} ${digest.sun.degree}°`;
  const moon = `${signName(digest.moon.sign, locale)} ${digest.moon.degree}°`;
  const asc = digest.ascendant ? signName(digest.ascendant, locale) : es ? "sin Ascendente definido" : "no defined Ascendant";
  const tight = tightest(digest);

  switch (section) {
    case "overview":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `Tu revolución solar coloca el Sol en ${sun}, en ${house("es", digest.sun.house)}: ahí se concentra la vitalidad del año. El Ascendente de la revolución es ${asc}, el lente con el que entras al año.`
            : `Your solar return places the Sun in ${sun}, in ${house("en", digest.sun.house)}: that is where the year's vitality gathers. The return Ascendant is ${asc}, the lens you walk into the year wearing.` },
          { kind: "prose", text: tight ? (es
            ? `El hilo más tensión del año es ${tight.a} en ${aspectType(tight.type, "es")} con tu ${tight.b} natal (órbita ${tight.orb}°): una conversación entre quien eres y en quién te conviertes.`
            : `The year's tightest thread is ${tight.a} in ${aspectType(tight.type, "en")} to your natal ${tight.b} (orb ${tight.orb}°): a conversation between who you are and who you are becoming.`)
            : (es ? "No hay aspectos cruzados destacables este año: el año habla en tono menor." : "No notable cross-aspects this year: the year speaks in a lower key.") },
          { kind: "callout", text: es ? `El año en una línea: crecer en ${house("es", digest.sun.house)} con la energía de ${signName(digest.sun.sign, "es")}.` : `The year in one line: grow in ${house("en", digest.sun.house)} with ${signName(digest.sun.sign, "en")} energy.` },
        ],
        closingQuestion: es
          ? `Con el Sol de tu año en ${house("es", digest.sun.house)}, ¿qué construirías ahí si este año te acompañara?`
          : `With your year's Sun in ${house("en", digest.sun.house)}, what would you build there if this year had your back?`,
      };
    case "sun":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `El Sol de tu revolución está en ${sun} y cae en ${house("es", digest.sun.house)}: la nota dominante del año suena en ese territorio.`
            : `Your return Sun sits in ${sun} and falls in ${house("en", digest.sun.house)}: the year's keynote sounds in that territory.` },
          { kind: "prose", text: es
            ? `Brillar este año significa encarnar lo mejor de ${signName(digest.sun.sign, "es")} exactamente ahí: una práctica pequeña y repetible en ${house("es", digest.sun.house)} basta.`
            : `Shining this year means embodying ${signName(digest.sun.sign, "en")} right there: one small, repeatable practice in ${house("en", digest.sun.house)} is enough.` },
          { kind: "callout", text: es ? `Práctica: dedica veinte minutos por semana a ${house("es", digest.sun.house)}.` : `Practice: give twenty minutes a week to ${house("en", digest.sun.house)}.` },
        ],
        closingQuestion: es
          ? `Y el clima emocional que acompaña a ese Sol, ¿cómo será? Sigue a la Luna para verlo.`
          : `And the emotional weather under that Sun? The Moon section has it.`,
      };
    case "moon":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `La Luna de la revolución está en ${moon}, en ${house("es", digest.moon.house)}: ese es el clima emocional del año y la habitación donde se despliega.`
            : `The return Moon is in ${moon}, in ${house("en", digest.moon.house)}: that is the year's emotional weather, and the room where it plays out.` },
          { kind: "prose", text: es
            ? `Tu Luna en ${signName(digest.moon.sign, "es")} pide ritmo y cuidado concretos: descanso con horario, no promesas vagas.`
            : `Your Moon in ${signName(digest.moon.sign, "en")} asks for concrete rhythm and care: rest with a schedule, not vague promises.` },
        ],
      };
    case "ascendant":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `El Ascendente de la revolución es ${asc}: la actitud con la que el año te encuentra al primer contacto.`
            : `The return Ascendant is ${asc}: the attitude the year meets you with at first contact.` },
          { kind: "callout", text: es ? `Cuidado con el lente: ${signName(digest.ascendant ?? digest.sun.sign, "es")} puede confundir velocidad con dirección.` : `A caveat on the lens: ${signName(digest.ascendant ?? digest.sun.sign, "en")} can mistake speed for direction.` },
        ],
      };
    case "aspects": {
      const rows = digest.crossAspects.slice(0, 8).map(a => ({ a: a.a, b: a.b, type: a.type, orb: a.orb }));
      return {
        blocks: [
          { kind: "prose", text: es
            ? `La geometría del año: los aspectos más exactos entre tu revolución y tu carta natal marcan los diálogos recurrentes del año.`
            : `The year's geometry: the tightest aspects between your return and your natal chart mark the year's recurring dialogues.` },
          { kind: "aspectTable", title: es ? "Aspectos cruzados más exactos" : "Tightest cross-aspects", rows: rows.length ? rows : [{ a: "—", b: "—", type: "conjunction", orb: 0 }] },
          { kind: "prose", text: es ? `Lee la tabla como una conversación: cada órbita menor es un diálogo más frecuente.` : `Read the table as a conversation: the smaller the orb, the more often the dialogue repeats.` },
        ],
      };
    }
```

> The file continues for 100 more lines (the `houses`, `planets`, `nodes`, `guidance` fixtures, `createFixtureProvider`, and `PROVIDERS`). Two excerpts matter most for the plan:

```ts
// ---- src/readings/provider.ts:245
export function createFixtureProvider(): ReadingProvider {
  return {
    name: "fixture",
    async complete(request: CompletionRequest): Promise<Completion> {
      const output = fixtureSection(request.section, request.locale, request.digest);
      const outputJson = JSON.stringify(output);
      const usage = {
        // The prompt already embeds the digest and schema — it IS the input.
        inputTokens: approxTokens(request.prompt),
        outputTokens: Math.min(approxTokens(outputJson), request.maxOutputTokens),
      };
      return {
        output,
        usage,
        model: request.model,
        latencyMs: 40 + Math.floor(usage.outputTokens / 8),
      };
    },
  };
}

// ---- src/readings/provider.ts:266
export const PROVIDERS: Record<string, () => ReadingProvider> = {
  fixture: createFixtureProvider,
};
```

And the unused helper at line 104, which no code path calls:

```ts
/** A body line like "Sun in Leo, 12.3°, 5th house, retrograde". */
function bodyLine(digest: ChartDigest, body: string, locale: Locale): string { /* ... */ }
```

### `src/readings/document.ts`

Lines: 167 · bytes: 6629

```ts
import { randomUUID } from "node:crypto";
import type { ChartDigest } from "@/lib/chart";
import type { Locale } from "@/lib/i18n";
import { availableSections, sectionDefinition } from "@/readings/registry";
import { FALLBACK_PROSE, LOCKED_TEASERS, SECTION_SUBTITLES, SECTION_TITLES } from "@/readings/copy";
import type { ProviderUsage } from "@/readings/provider";
import { SECTION_KEYS, type LockedSection, type ReadingDocument, type ReadingSection, type SectionKey, type SectionTier } from "@/readings/types";

/**
 * Document assembly (`docs/plan-readings-engine-epic.md` §2). Pure: takes the
 * per-section outcomes from the pipeline and freezes them into the persisted
 * shape, including locked-section copy and graceful fallback blocks. Assembly
 * never dispatches anything — a document is a record, not a live view.
 */

export type SectionResult =
  | {
      key: SectionKey;
      status: "generated";
      fromCache: boolean;
      output: { blocks: ReadingSection["blocks"]; closingQuestion?: string };
      model: string;
      usage: ProviderUsage;
      /** MXN spent by *this* run (cache hits carry 0). */
      costMxn: number;
      latencyMs: number;
    }
  | { key: SectionKey; status: "failed"; failureReason: string; /** MXN wasted on attempts that produced nothing. */ costMxn?: number };

/** The digest facts each section is grounded in — also the fallback content. */
function sectionFacts(digest: ChartDigest, key: SectionKey): Record<string, unknown> {
  switch (key) {
    case "overview":
      return { sun: digest.sun, ascendant: digest.ascendant, crossAspects: digest.crossAspects.slice(0, 5) };
    case "sun":
      return { sun: digest.sun };
    case "moon":
      return { moon: digest.moon };
    case "ascendant":
      return { ascendant: digest.ascendant, midheaven: digest.midheaven, sunHouse: digest.sun.house };
    case "aspects":
      return { aspects: digest.aspects.slice(0, 10), crossAspects: digest.crossAspects.slice(0, 10) };
    case "houses":
      return { bodiesByHouse: digest.bodies.reduce<Record<string, string[]>>((acc, b) => {
        if (b.house === null) return acc;
        (acc[b.house] ??= []).push(b.body);
        return acc;
      }, {}) };
    case "planets":
      return { bodies: digest.bodies };
    case "nodes":
      return { nodes: digest.nodes };
    case "planetaryYear":
      return { profections: (digest as unknown as Record<string, unknown>).profections ?? null };
    case "transits":
      return { transits: (digest as unknown as Record<string, unknown>).transits ?? null };
    case "guidance":
      return { sun: digest.sun, moon: digest.moon, nodes: digest.nodes, crossAspects: digest.crossAspects.slice(0, 5) };
  }
}

function factsToEntries(facts: Record<string, unknown>, locale: Locale): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(facts)) {
    if (value === null || value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    entries.push({ key, value: text.length > 300 ? `${text.slice(0, 297)}...` : text });
    if (entries.length >= 20) break;
  }
  if (!entries.length) entries.push({ key: locale === "es" ? "carta" : "chart", value: locale === "es" ? "disponible" : "available" });
  return entries;
}

/** Static fallback blocks so a failed section still renders chart truth. */
export function fallbackBlocks(digest: ChartDigest, key: SectionKey, locale: Locale): ReadingSection["blocks"] {
  const facts = sectionFacts(digest, key);
  return [
    { kind: "prose", text: FALLBACK_PROSE[locale] },
    { kind: "keyValue", title: locale === "es" ? "Datos de tu carta" : "Your chart's facts", entries: factsToEntries(facts, locale) },
  ];
}

export function buildReadingDocument(args: {
  readingId: string;
  documentId?: string;
  locale: Locale;
  tier: SectionTier;
  digest: ChartDigest;
  contentVersion: string;
  results: SectionResult[];
}): ReadingDocument {
  const { readingId, locale, tier, digest, contentVersion, results } = args;
  const attempted = new Set(results.map(result => result.key));
  const sections: ReadingSection[] = [];
  const models: Partial<Record<SectionKey, string>> = {};
  let costMxn = 0;
  let wastedCostMxn = 0;

  for (const key of SECTION_KEYS) {
    const result = results.find(r => r.key === key);
    if (!result) continue;
    const definition = sectionDefinition(key);
    const facts = sectionFacts(digest, key);
    if (result.status === "generated") {
      models[key] = result.model;
      costMxn += result.costMxn;
      sections.push({
        key,
        tier: definition.tier,
        title: SECTION_TITLES[key][locale],
        subtitle: SECTION_SUBTITLES[key][locale],
        blocks: result.output.blocks,
        facts,
        status: "generated",
        closingQuestion: result.output.closingQuestion,
      });
    } else {
      wastedCostMxn += result.costMxn ?? 0;
      sections.push({
        key,
        tier: definition.tier,
        title: SECTION_TITLES[key][locale],
        subtitle: SECTION_SUBTITLES[key][locale],
        blocks: fallbackBlocks(digest, key, locale),
        facts,
        status: "failed",
        failureReason: result.failureReason,
      });
    }
  }

  // Locked = paid, available for this chart, and not in the document (free tier's
  // upsell surface). Sections whose facts the engine doesn't compute yet are
  // absent entirely, not locked.
  const lockedSections: LockedSection[] = availableSections(digest)
    .filter(key => sectionDefinition(key).tier === "paid" && !attempted.has(key))
    .map(key => ({ key, title: SECTION_TITLES[key][locale], teaser: LOCKED_TEASERS[key][locale] }));

  return {
    id: args.documentId ?? randomUUID(),
    readingId,
    locale,
    chartVersion: digest.chartVersion,
    contentVersion,
    models,
    generatedAt: new Date().toISOString(),
    tier,
    sections,
    lockedSections,
    costMxn: Number(costMxn.toFixed(6)),
    wastedCostMxn: Number(wastedCostMxn.toFixed(6)),
  };
}

/**
 * A document is persisted only if it carries generated content under a real
 * contentVersion. An all-fallback document (outage, missing provider config,
 * unpersistable version) must NOT occupy the insert-only
 * (readingId, locale, contentVersion) slot — that would permanently block
 * regeneration for that reading after the outage clears.
 */
export function persistableDocument(document: ReadingDocument): boolean {
  return (
    document.contentVersion !== "unavailable" &&
    document.sections.some(section => section.status === "generated")
  );
}
```

### `src/readings/db-cache.ts`

Lines: 51 · bytes: 1987

```ts
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { generationCache } from "@/db/schema";
import type { CachedSection, SectionCache, SectionCacheKey } from "@/readings/generate";
```

> remainder is the two-method `DbSectionCache` shown in part 1 of the raw dump above (`get` reads four columns by cache key, `put` inserts with `onConflictDoNothing`).

```ts
/** Production SectionCache over `generation_cache`. Insert-only: on conflict it
 * does nothing, so the frozen original always wins (epic §4.2, §4.5). Reads
 * miss (not error) on any DB hiccup — a generation rerun is always safe. */
export class DbSectionCache implements SectionCache {
  async get(key: SectionCacheKey): Promise<CachedSection | null> { /* select ... limit(1) */ }
  async put(key: SectionCacheKey, value: CachedSection): Promise<void> { /* insert ... onConflictDoNothing() */ }
}
```

## 1.4 The generation pipeline

### `src/readings/generate.ts`

443 lines. The structure, with the exact ordering that the plan must respect:

```ts
// resolveProvider() :135 — a null return is the "no generation" state
function resolveProvider(): ReadingProvider | null {
  const name = providerName();                     // process.env.READINGS_PROVIDER
  const factory = name ? PROVIDERS[name] : undefined;
  return factory ? factory() : null;
}

export async function generateReadingDocument(args: GenerateDocumentArgs): Promise<ReadingDocument> {
  const wanted = sectionsForTier(args.tier).filter(key => availableSections(args.digest).includes(key));
  // contentVersion → "unavailable" if prompts unreadable ⇒ nothing dispatched
  for (const key of wanted) {
    // kill switch        → failureReason "generation_disabled"
    // runHalted          → failureReason "generation_halted: <reason>"
    // cache.get          → hit ⇒ status generated, costMxn 0
    // no provider        → "provider_unavailable"
    // priceFor(model)    → null ⇒ "pricing_unavailable" (pre-dispatch, fail closed)
    // sectionJsonSchema + assemblePrompt → "prompt_unavailable"
    // ceiling, pre-dispatch: spent + 2 × projectedOnce > ceiling ⇒ "cost_ceiling"
    // provider.complete(...)
    // account()          → invalid usage / unpriced model ⇒ runHalted + worst-case booking
    // validateSectionOutput → ONE repair attempt, ceiling re-checked on the repair prompt
    // spent > ceiling post-dispatch ⇒ "cost_ceiling_exceeded_after_dispatch"
    // cache.put(worst-effort) → results.push({status:"generated", ...})
  }
  return buildReadingDocument({ readingId, documentId, locale, tier, digest, contentVersion, results });
}
```

Two `resolveProvider` call sites, one shape:

```ts
// src/readings/generate.ts:135-139
function resolveProvider(): ReadingProvider | null {
  const name = providerName();
  const factory = name ? PROVIDERS[name] : undefined;
  return factory ? factory() : null;
}
```

## 1.5 Routes

### `src/app/api/readings/route.ts`

96 lines

```ts
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { readings, readingDocuments } from "@/db/schema";
/* ... */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Please sign in to save your chart." }, { status: 401 });
  // parse ChartInput → calculateSolarReturn → 400 on bad input
  try {
    const [saved] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning({ id: readings.id });

    // Reading document generation (#103). Behind READINGS_GENERATION_ENABLED
    // (default off) and after the save, so the chart is never at risk: the
    // pipeline itself never throws, and this guard is belt-and-braces. The
    // consent gate (#105) slots in here before any flag flip.
    if (generationEnabled()) {
      try {
        const locale = await getLocale();
        const { facts } = calculateSolarReturnChart(input);
        const document = await generateReadingDocument({
          readingId: saved.id,
          locale,
          tier: "free",          // ← hardcoded: only the free tier is ever generated
          digest: chartDigest(facts),
          cache: new DbSectionCache(),
        });
        if (!persistableDocument(document)) {
          // log readings.document_not_persisted with cost + wastedCost, return { id }
          return NextResponse.json({ id: saved.id });
        }
        const inserted = await db.insert(readingDocuments).values({
          id: document.id,
          readingId: saved.id,
          locale,
          contentVersion: document.contentVersion,
          chartVersion: document.chartVersion,
          tier: document.tier,
          document,                 // ← column is `document`, not `content`
        }).onConflictDoNothing()      // freeze: an existing row for this key always wins
          .returning({ id: readingDocuments.id });
        if (inserted.length > 0) return NextResponse.json({ id: saved.id, documentId: inserted[0].id });
        // conflict ⇒ return the id of the row that actually holds the document
        return NextResponse.json({ id: saved.id, documentId: existing[0]?.id });
      } catch (error) {
        log.error("readings.generation_failed", { /* ... */ });
      }
    }
    return NextResponse.json({ id: saved.id });
  } catch (error) { /* 500 */ }
}
```

### `src/app/api/readings/[id]/route.ts`

```ts
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { currentUser } from "@/lib/auth";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid chart." }, { status: 400 });
  await db.delete(readings).where(and(eq(readings.id, id), eq(readings.userId, user.id)));
  return NextResponse.json({ ok: true });
}
```

There is **no `GET`** on this route. Nothing serves a document over the API.

### `src/app/api/readings/[id]/pdf/route.ts`

23 lines

```ts
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
import { getReadingNotes } from "@/lib/reading-content";
import { SolarReturnDocument } from "@/components/solar-pdf";
import { log, requestMeta } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  const user=await currentUser(); if(!user) return new Response("Unauthorized",{status:401});
  const {id}=await params; if(!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found",{status:404});
  const [chart]=await db.select().from(readings).where(and(eq(readings.id,id),eq(readings.userId,user.id))).limit(1);
  if(!chart) return new Response("Not found",{status:404});
  try {
    const locale=await getLocale(); const notes=await getReadingNotes(chart.result,locale);
    const renderer=await import("@react-pdf/renderer");
    const buffer=await renderer.renderToBuffer(SolarReturnDocument({input:chart.input,result:chart.result,notes,locale,premium:user.plan==="paid",renderer}));
    return new Response(new Uint8Array(buffer),{headers:{"Content-Type":"application/pdf","Content-Disposition":`attachment; filename="solara-${chart.year}-${locale}.pdf"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  } catch(error) { log.error("readings.pdf_failed", { ...requestMeta(request), userId: user.id, error }); return new Response("Unable to generate PDF",{status:500}); }
}
```

Note what it does **not** do: no `readingDocuments` query, no section rendering, no subscription call beyond `user.plan` (which `currentUser` already derives from `hasPremiumAccess`).

## 1.6 The reading page

### `src/app/reading/[id]/page.tsx`

25 lines, single-line JSX per repo convention. Structure:

```
notFound on bad uuid → currentUser() → redirect to /account?next=… if anon
→ select reading where id AND userId (ownership enforced in SQL)
→ getReadingNotes(result, locale)          ← prose from the `knowledge` table
→ DateTime formatting, 4 placement cards (Sun / Moon / Asc / Sun's house)
→ AstroWheel (decorative, aria-labelled)
→ panel: notes.sun (+ "illustrative, not predictions" notice)
→ user.plan === "paid"
     ? panel: notes.moon + notes.ascendant + notes.house
     : panel "premium-teaser": static copy + <Link href="/pricing">
→ panel: chart details + DeleteReading
```

The important absences, verified by grep:

- **`readingDocuments`: 0 occurrences.** The page never touches the frozen document.
- **`LOCKED_CTA`: 0 occurrences anywhere in `src/`.** The CTA string is defined in `copy.ts` and never rendered.
- **`FALLBACK_PROSE`: only `document.ts`.** Nothing in the UI shows `failureReason` or the `status: "failed"` state.
- Sections render as one `<p>{notes.sun}</p>`; no blocks, no tables, no callouts.

## 1.7 The PDF renderer

### `src/components/solar-pdf.tsx`

40 lines, three `<Page>` elements:

1. Cover — name, year, `PREMIUM EDITION` / `FREE SUMMARY` by `premium`, decorative sun.
2. "Your moment in time" — placement grid, `notes.sun` paragraph, UTC + house-system detail lines, disclaimers.
3. **Premium only** — `notes.moon`, `notes.ascendant`, `notes.house`, disclaimer.

Signature:

```tsx
export function SolarReturnDocument({ input,result,notes,locale,premium,renderer }:
  { input:ChartInput; result:ChartResult; notes:ReadingNotes; locale:Locale; premium:boolean; renderer:PdfRenderer }
): React.ReactElement<DocumentProps>
```

It takes `notes: ReadingNotes` — a 4-field object of `knowledge`-table prose. **It has no access to `ReadingDocument`.** The "full editorial PDF" cannot be built by extending this signature; it needs a `ReadingDocument` argument.

## 1.8 Entitlement and account surface

### `src/lib/auth.ts`

50 lines. The entitlement path already exists and is already wired:

```ts
export async function hasPremiumAccess(userId: string) {
  const [active] = await db.select({ id: subscriptions.stripeSubscriptionId }).from(subscriptions).where(and(
    eq(subscriptions.userId, userId), eq(subscriptions.grantsAccess, true),
    inArray(subscriptions.status, ["active", "trialing"]), gt(subscriptions.currentPeriodEnd, new Date()),
  )).limit(1);
  return !!active;
}

export async function currentUser() {
  // session cookie → sha256 → sessions ⨝ users (emailVerifiedAt NOT NULL)
  return { ...user, plan: await hasPremiumAccess(user.id) ? "paid" as const : "free" as const };
}
```

`currentUser()` returns `{ id, name, email, role, stripeCustomerId, emailVerifiedAt, plan }`. `plan` is derived per request from `subscriptions`; `users.plan` is a vestigial display column that nothing reads for gating.

`hasPremiumAccess` has **zero callers outside `auth.ts`** — it is the trusted primitive, and `currentUser().plan` is its only consumer.

### `src/lib/billing.ts`

41 lines, exports: `BillingCurrency`, `PriceOption`, `getStripe`, `priceIdFor`, `billingIsConfigured`, `isPremiumPrice`, `appOrigin`, `getPriceCatalog`.

There is **no checkout-URL helper**. Checkout lives entirely in `POST /api/billing/checkout`, which returns `{ url }` (or a 409 when a subscription already exists). That is the only entry point, and it already handles: email verification, an existing-subscription guard against both our table and Stripe, reuse of an open checkout session, customer creation with an idempotency key, and locale.

### `src/lib/reading-content.ts`

31 lines.

```ts
export type ReadingNotes = { sun:string; moon:string; ascendant:string|null; house:string|null };
export async function getReadingNotes(result:ChartResult, locale:Locale):Promise<ReadingNotes>
// reads `knowledge` by contentKey(category,item,locale), falls back to defaultNote()
```

This is the *old* content path (4 notes from a CRUD table), and it is what both the page and the PDF still use. It is not going away immediately — see the amendment for how the two coexist.

## 1.9 Persistence schema (readings engine)

```ts
export const readings = pgTable("readings", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  year: integer("year").notNull(),
  input: jsonb("input").$type<ChartInput>().notNull(),
  result: jsonb("result").$type<ChartResult>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const readingDocuments = pgTable("reading_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  readingId: uuid("reading_id").notNull().references(() => readings.id, { onDelete: "cascade" }),
  locale: text("locale").$type<"en" | "es">().notNull(),
  contentVersion: text("content_version").notNull(),
  chartVersion: text("chart_version").notNull(),
  tier: text("tier").$type<"free" | "paid">().notNull(),
  document: jsonb("document").$type<ReadingDocument>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("reading_documents_reading_locale_version_key").on(table.readingId, table.locale, table.contentVersion)]);

export const generationCache = pgTable("generation_cache", {
  digestHash: text("digest_hash").notNull(),
  section: text("section").notNull(),
  locale: text("locale").notNull(),
  contentVersion: text("content_version").notNull(),
  model: text("model").notNull(),
  usage: jsonb("usage").$type<ProviderUsage>().notNull(),
  costMxn: doublePrecision("cost_mxn").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  output: jsonb("output").$type<SectionOutput>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.digestHash, table.section, table.locale, table.contentVersion] })]);
```

The unique index has **no `tier` column**. A paid document for the same reading/locale/contentVersion therefore collides with the free one. This is the single most important schema fact for step 6 of the plan.

## 1.10 Prompt wrapper (what the model actually receives)

```md
{{sectionBrief}}

The reader's chart (computed deterministically, do not recompute it):
{{digestJson}}

Your response must validate against this JSON Schema:
{{jsonSchema}}

Write for one reader. Warm, literate, specific to their chart. Reflection, not prediction; possibility, not fate. Never give medical, legal, or financial directives.
```

For the record — the wrapper asks for **JSON only**, and the schema is supplied per-section. A real adapter must send both, and must not attempt to parse prose.
