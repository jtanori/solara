import { z } from "zod";
import { SIGN_NAMES } from "@/lib/astro";
import { signName, type Locale } from "@/lib/i18n";
import { readingBlockSchema } from "@/readings/schemas";
import { sectionDefinition } from "@/readings/registry";
import { SECTION_KEYS, type ReadingBlock, type SectionKey } from "@/readings/types";
import { PAID_CORE_SECTIONS } from "@/readings/paid-contract";
import { readingPreviews } from "@/readings/presentation-copy";
import { READING_LIMITS, READING_PRESENTATION_VERSION, sectionText, type DisplaySection, type SavedReadingPresentation } from "@/readings/presentation";

const identity = z.object({
  id: z.string().uuid(), readingId: z.string().uuid(), locale: z.enum(["en", "es"]),
  contentVersion: z.string().min(1).max(128), chartVersion: z.string().min(1).max(128),
  tier: z.enum(["free", "paid"]),
});
const envelope = identity.extend({
  generatedAt: z.iso.datetime({ offset: true }),
  sections: z.array(z.unknown()).min(1).max(SECTION_KEYS.length),
});
const sectionHeader = z.object({
  key: z.enum(SECTION_KEYS), tier: z.enum(["free", "paid"]),
  title: z.string().min(1).max(200), subtitle: z.string().min(1).max(200).optional(),
  status: z.enum(["generated", "overridden", "failed"]),
  blocks: z.array(z.unknown()).max(30), facts: z.unknown().optional(), closingQuestion: z.unknown().optional(),
});
const knownKinds = new Set(["prose", "callout", "list", "keyValue", "aspectTable"]);
const blockKind = z.object({ kind: z.string().min(1).max(64) });
const sunFacts = z.object({ sun: z.object({
  sign: z.enum(SIGN_NAMES), degree: z.number().min(0).max(30), house: z.number().int().min(1).max(12).nullable(),
}) });

export type StoredDocumentIdentity = z.infer<typeof identity>;
export type StoredDocumentResult = { ok: true; value: SavedReadingPresentation } | { ok: false; code: "invalid_document" | "document_too_large" | "document_unavailable" };

/** Only known chart truth, never an arbitrary facts/failed-block JSON dump. */
function failureFacts(key: SectionKey, facts: unknown, locale: Locale): ReadingBlock[] {
  if (key !== "overview" && key !== "sun") return [];
  const parsed = sunFacts.safeParse(facts);
  if (!parsed.success) return [];
  const { sun } = parsed.data;
  const es = locale === "es";
  const entries = [{ key: es ? "Sol" : "Sun", value: `${signName(sun.sign, locale)} ${sun.degree}°` }];
  if (sun.house !== null) entries.push({ key: es ? "Casa del Sol" : "Sun house", value: String(sun.house) });
  return [{ kind: "keyValue", title: es ? "Datos guardados de tu carta" : "Saved chart facts", entries }];
}

/**
 * Decode bounded persisted JSON, not fresh provider output. New block kinds may
 * be omitted; identity/tier violations must never be laundered by filtering.
 * The returned object is constructed field-by-field and contains no raw metadata.
 */
export function readStoredDocument(
  serialized: string,
  expected: StoredDocumentIdentity,
  options: { legacy?: boolean; allowPaid?: boolean; expectedSections?: readonly SectionKey[] } = {},
): StoredDocumentResult {
  if (Buffer.byteLength(serialized, "utf8") > READING_LIMITS.documentBytes) return { ok: false, code: "document_too_large" };
  let raw: unknown;
  try { raw = JSON.parse(serialized); } catch { return { ok: false, code: "invalid_document" }; }
  const parsed = envelope.safeParse(raw);
  const expectedIdentity = identity.safeParse(expected);
  if (!parsed.success || !expectedIdentity.success) return { ok: false, code: "invalid_document" };
  const document = parsed.data;
  for (const key of ["id", "readingId", "locale", "contentVersion", "chartVersion", "tier"] as const) {
    if (document[key] !== expectedIdentity.data[key]) return { ok: false, code: "invalid_document" };
  }
  if (document.tier === "paid" && !options.allowPaid) return { ok: false, code: "invalid_document" };
  const sections: DisplaySection[] = [];
  const seen = new Set<SectionKey>();
  let textLength = 0;
  let usable = 0;
  for (const rawSection of document.sections) {
    const parsedSection = sectionHeader.safeParse(rawSection);
    if (!parsedSection.success) return { ok: false, code: "invalid_document" };
    const source = parsedSection.data;
    if (seen.has(source.key) || source.tier !== sectionDefinition(source.key).tier ||
      (document.tier === "free" && (source.key !== "overview" && source.key !== "sun"))) {
      return { ok: false, code: "invalid_document" };
    }
    seen.add(source.key);
    const section: DisplaySection = {
      key: source.key, tier: source.tier, title: source.title,
      ...(source.subtitle ? { subtitle: source.subtitle } : {}),
      status: source.status, blocks: [], notices: [],
    };
    if (source.status === "failed") {
      section.notices.push("section_failed");
      section.blocks = failureFacts(source.key, source.facts, document.locale);
    } else {
      let invalid = false;
      let unsupported = false;
      for (const block of source.blocks) {
        const kind = blockKind.safeParse(block);
        if (!kind.success) { invalid = true; break; }
        if (!knownKinds.has(kind.data.kind)) { unsupported = true; continue; }
        const validated = readingBlockSchema.safeParse(block);
        if (!validated.success) { invalid = true; break; }
        section.blocks.push(validated.data);
      }
      const requiresQuestion = document.tier === "free" && (source.key === "overview" || source.key === "sun");
      if (source.closingQuestion !== undefined) {
        const question = z.string().min(requiresQuestion && !options.legacy ? 10 : 1).max(500).safeParse(source.closingQuestion);
        if (question.success) section.closingQuestion = question.data;
        else invalid = true;
      } else if (requiresQuestion) {
        if (options.legacy) section.notices.push("legacy_question_missing");
        else invalid = true;
      }
      if (invalid || !section.blocks.length) {
        section.blocks = [];
        delete section.closingQuestion;
        section.notices = ["section_unavailable"];
      } else {
        usable++;
        if (unsupported) section.notices.push("unsupported_blocks");
      }
    }
    textLength += sectionText(section).reduce((sum, text) => sum + text.length, 0);
    if (textLength > (document.tier === "free" ? READING_LIMITS.freeText : READING_LIMITS.paidText)) {
      return { ok: false, code: "document_too_large" };
    }
    sections.push(section);
  }
  if (!usable) return { ok: false, code: "document_unavailable" };
  const expectedSections = document.tier === "paid" ? options.expectedSections ?? PAID_CORE_SECTIONS : ["overview", "sun"] as const;
  if (!expectedSections.length || new Set(expectedSections).size !== expectedSections.length ||
    expectedSections.some(key => !SECTION_KEYS.includes(key)) || [...seen].some(key => !expectedSections.includes(key))) return { ok: false, code: "invalid_document" };
  const missing = expectedSections.some(key => !seen.has(key));
  // Older complete documents predate closing questions; disclose that history
  // without mislabeling intact saved content as a partial generation.
  const partial = missing || sections.some(section => section.status === "failed" || section.notices.some(notice => notice !== "legacy_question_missing"));
  return { ok: true, value: {
    kind: "saved-reading", id: document.id, readingId: document.readingId, locale: document.locale,
    contentVersion: document.contentVersion, chartVersion: document.chartVersion, generatedAt: document.generatedAt,
    tier: document.tier, presentationVersion: READING_PRESENTATION_VERSION, sections,
    previews: document.tier === "free" ? readingPreviews(document.locale) : [],
    partial, notices: [...(partial ? ["partial" as const] : []), ...(missing ? ["missing_sections" as const] : [])],
  } };
}
