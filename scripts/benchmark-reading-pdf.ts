import { cpus, totalmem } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { ReadingPdfRenderer } from "../src/readings/pdf-render";
import { READING_LIMITS, sectionText } from "../src/readings/presentation";
import { chartNotes } from "../src/readings/chart-presentation";
import { pdfFixture } from "../tests/helpers/reading-pdf";
import type { ReadingPdfInput } from "../src/readings/pdf-contract";

// Pure frozen synthetic data, no auth, DB, network or provider configuration.
function maximum(input: ReadingPdfInput, limit: number) {
  input.content.sections.forEach(section => { section.blocks = []; });
  let remaining = limit - input.content.sections.flatMap(sectionText).reduce((sum, text) => sum + text.length, 0);
  const phrase = input.content.locale === "es" ? "Atención, práctica y reflexión durante el año. " : "Attention, practice and reflection throughout the year. ";
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(4000, remaining);
    input.content.sections[index++ % input.content.sections.length].blocks.push({ kind: "prose", text: phrase.repeat(Math.ceil(size / phrase.length)).slice(0, size) }); remaining -= size;
  }
  return input;
}
const longNotes = pdfFixture("es");
longNotes.content = chartNotes(longNotes.chart, { sun: "Nota ilustrativa. ".repeat(220), moon: "Luna ilustrativa. ".repeat(220), ascendant: "Ascendente. ".repeat(300), house: "Casa ilustrativa. ".repeat(220) }, "es", true);
const cases: Record<string, ReadingPdfInput> = {
  "free-en": pdfFixture(), "free-es": pdfFixture("es"),
  "maximum-free-en": maximum(pdfFixture(), READING_LIMITS.freeText), "maximum-free-es": maximum(pdfFixture("es"), READING_LIMITS.freeText),
  "partial-overview-en": pdfFixture("en", "partial-overview"), "partial-sun-es": pdfFixture("es", "partial-sun"),
  "long-notes-es": longNotes, "paid-en": pdfFixture("en", "paid"), "paid-es": pdfFixture("es", "paid"),
  "maximum-paid-en": maximum(pdfFixture("en", "paid"), READING_LIMITS.paidText), "maximum-paid-es": maximum(pdfFixture("es", "paid"), READING_LIMITS.paidText),
};
async function main() {
const samples = process.argv.includes("--spike") ? 1 : 21;
const names = process.argv.filter(argument => argument.startsWith("--case=")).map(argument => argument.slice(7));
const result = { node: process.version, cpu: cpus()[0].model, cpuCount: cpus().length, totalMemoryBytes: totalmem(), cgroupMemory: "unknown", samplesPerCase: samples, renderer: "4.9.0", font: "@fontsource/noto-sans@5.3.0", cases: {} as Record<string, unknown> };
try { result.cgroupMemory = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(); } catch { /* Numeric host budget remains separately verified. */ }
const renderer = new ReadingPdfRenderer();
for (const [name, input] of Object.entries(cases)) {
  if (names.length && !names.includes(name)) continue;
  const timings: number[] = []; const bytes: number[] = []; const pages: number[] = []; const rss: number[] = []; let failure: string | null = null;
  for (let i = 0; i < samples; i++) {
    try {
      const measured = await renderer.render(input);
      timings.push(Math.round(measured.durationMs)); bytes.push(measured.buffer.length); pages.push(measured.pages); rss.push(measured.peakRss);
    } catch (error) { failure = error instanceof Error ? error.message : "failed"; break; }
  }
  const warm = timings.slice(1).sort((a, b) => a - b);
  result.cases[name] = { firstRequestMs: timings[0] ?? null, warmP95Ms: warm.length ? warm[Math.ceil(warm.length * .95) - 1] : null, timingsMs: timings, outputBytes: Math.max(0, ...bytes), pages: Math.max(0, ...pages), childPeakRss: Math.max(0, ...rss), parentPeakRss: process.resourceUsage().maxRSS * 1024, failure };
  console.log(name, result.cases[name]);
}
mkdirSync(".venv", { recursive: true });
writeFileSync(process.argv.includes("--spike") ? ".venv/reading-pdf-resource-spike.json" : ".venv/reading-pdf-resource-results.json", JSON.stringify(result, null, 2) + "\n");
if (Object.values(result.cases).some(value => (value as { failure: string | null }).failure)) process.exitCode = 1;

}
void main().catch(() => { console.error("PDF benchmark failed"); process.exitCode = 1; });
