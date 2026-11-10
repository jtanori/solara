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
