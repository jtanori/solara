import { z } from "zod";
import type { ReadingBlock } from "@/readings/types";
import type { SectionKey, SectionTier } from "@/readings/types";

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

function buildSectionSchema(key: SectionKey, tier: SectionTier) {
  return z.strictObject({
    blocks: z.array(readingBlockSchema).min(1).max(30),
    closingQuestion: tier === "free" && CLIFFHANGER_SECTIONS.includes(key) ? z.string().min(10).max(500) : z.string().min(1).max(500).optional(),
  });
}

const sectionSchemas = new Map<string, z.ZodType<SectionOutput>>();
export function sectionSchema(key: SectionKey, tier: SectionTier = "free"): z.ZodType<SectionOutput> {
  let schema = sectionSchemas.get(`${tier}:${key}`);
  if (!schema) {
    schema = buildSectionSchema(key, tier);
    sectionSchemas.set(`${tier}:${key}`, schema);
  }
  return schema;
}

const jsonSchemas = new Map<string, Record<string, unknown>>();
/** Draft 2020-12 JSON Schema for a section, memoized — this is what the provider validates against. */
export function sectionJsonSchema(key: SectionKey, tier: SectionTier = "free"): Record<string, unknown> {
  let json = jsonSchemas.get(`${tier}:${key}`);
  if (!json) {
    json = z.toJSONSchema(sectionSchema(key, tier)) as Record<string, unknown>;
    jsonSchemas.set(`${tier}:${key}`, json);
  }
  return json;
}

export type SectionValidation =
  | { ok: true; value: SectionOutput }
  | { ok: false; error: string };

/** Validate raw provider output. Never throws — the repair path needs the reason. */
export function validateSectionOutput(key: SectionKey, data: unknown, tier: SectionTier = "free"): SectionValidation {
  const result = sectionSchema(key, tier).safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  const allowedPaths = new Set(["blocks", "kind", "text", "title", "items", "entries", "key", "value", "rows", "a", "b", "type", "orb", "closingQuestion"]);
  const issues = result.error.issues.slice(0, 12).map(issue => {
    // Zod messages/unknown keys can echo provider-controlled text. Repairs and
    // public failures use only known schema paths and stable validator codes.
    const path = issue.path.filter(part => typeof part === "number" || allowedPaths.has(String(part))).join("/");
    return `/${path}: ${issue.code}`;
  });
  return { ok: false, error: `schema validation failed for section "${key}":\n${issues.join("\n")}` };
}
