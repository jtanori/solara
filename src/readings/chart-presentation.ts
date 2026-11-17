import { z } from "zod";
import { IANAZone } from "luxon";
import { SIGN_NAMES } from "@/lib/astro";
import { signName, type Locale } from "@/lib/i18n";
import type { ReadingNotes } from "@/lib/reading-content";
import { ReadingViewError, type ChartNotesPresentation, type DisplaySection, type ReadingChart, type ReadingSelector } from "@/readings/presentation";

const placement = z.object({ sign: z.enum(SIGN_NAMES), longitude: z.number().min(0).max(360), degree: z.number().min(0).max(30) });
const chartSchema = z.object({
  id: z.string().uuid(), year: z.number().int().min(1).max(9999),
  name: z.string().min(1).max(200), returnPlace: z.string().min(1).max(400),
  timezone: z.string().min(1).max(100).refine(value => IANAZone.isValidZone(value)),
  result: z.object({
    exactUtc: z.iso.datetime({ offset: true }), localTime: z.string().max(200),
    natalSun: placement, moon: placement, ascendant: placement.nullable(),
    sunHouse: z.number().int().min(1).max(12).nullable(), houseSystem: z.literal("Whole sign"),
    warnings: z.array(z.string().max(512)).max(20), engine: z.string().max(200),
  }),
});
export function readChart(value: unknown): ReadingChart {
  const parsed = chartSchema.safeParse(value);
  if (!parsed.success) throw new ReadingViewError("invalid_chart");
  return parsed.data;
}
export function isReadingId(value: string): boolean { return z.string().uuid().safeParse(value).success; }

/** Reject repeated/conflicting/unknown control parameters, not just their first value. */
export function readingSelector(params: URLSearchParams): ReadingSelector {
  for (const key of params.keys()) if (key !== "document" && key !== "edition") throw new ReadingViewError("invalid_selection");
  const ids = params.getAll("document");
  const editions = params.getAll("edition");
  if (ids.length > 1 || editions.length > 1 || (ids.length && editions.length)) throw new ReadingViewError("invalid_selection");
  if (ids.length) {
    if (!isReadingId(ids[0])) throw new ReadingViewError("invalid_selection");
    return { kind: "document", id: ids[0] };
  }
  if (editions.length) {
    if (editions[0] !== "chart") throw new ReadingViewError("invalid_selection");
    return { kind: "chart" };
  }
  return { kind: "auto" };
}

/** Notes remain mutable and explicitly illustrative; never mixed into a saved document. */
export function chartNotes(chart: ReadingChart, notes: ReadingNotes | null, locale: Locale, extended: boolean): ChartNotesPresentation {
  const es = locale === "es";
  const candidates: { key: DisplaySection["key"]; title: string; text: unknown }[] = [
    { key: "sun", title: es ? `Tu Sol en ${signName(chart.result.natalSun.sign, locale)}` : `Your Sun in ${chart.result.natalSun.sign}`, text: notes?.sun },
  ];
  if (extended) {
    candidates.push({ key: "moon", title: es ? `La Luna en ${signName(chart.result.moon.sign, locale)}` : `The Moon in ${chart.result.moon.sign}`, text: notes?.moon });
    if (chart.result.ascendant) candidates.push({ key: "ascendant", title: es ? `Ascendente en ${signName(chart.result.ascendant.sign, locale)}` : `${chart.result.ascendant.sign} rising`, text: notes?.ascendant });
    if (chart.result.sunHouse) candidates.push({ key: "houses", title: es ? `El Sol en la casa ${chart.result.sunHouse}` : `The Sun in house ${chart.result.sunHouse}`, text: notes?.house });
  }
  const sections: DisplaySection[] = [];
  for (const candidate of candidates) {
    const validated = z.string().min(1).max(4000).safeParse(candidate.text);
    if (!validated.success) continue;
    sections.push({ key: candidate.key, tier: candidate.key === "sun" ? "free" : "paid", title: candidate.title,
      status: "overridden", blocks: [{ kind: "prose", text: validated.data }], notices: [],
    });
  }
  return { kind: "chart-notes", locale, sections, notices: sections.length < candidates.length ? ["notes_unavailable"] : [] };
}
