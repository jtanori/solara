import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChartInput } from "../../src/lib/types";
import type { Locale } from "../../src/lib/i18n";
import { ReadingPageView } from "../../src/components/reading-page-view";
import { SECTION_MODEL_TIER } from "../../src/readings/config";
import type { SectionResult } from "../../src/readings/document";
import { paidEvaluationSchema, type EvaluationSample, type PaidEvaluationReport } from "../../src/readings/evaluation";
import { handleReadingPdf } from "../../src/readings/pdf-http";
import { ReadingPdfRenderer } from "../../src/readings/pdf-render";
import type { PaidProfile } from "../../src/readings/paid-contract";
import { loadReadingPresentation } from "../../src/readings/reading-view";
import type { ReadingPresentation } from "../../src/readings/presentation";
import { syntheticPaidEdition } from "../../tests/helpers/paid-edition";
import { syntheticReadingAccount } from "../../tests/helpers/reading-account";
import { loadChartCorpus } from "./chart-corpus";

/**
 * #225 / A2 — render a genuine pilot report through the real saved-edition path.
 *
 * The report carries the sections and attempts. It does not carry the Placidus snapshot, so the
 * snapshot is computed from the corpus input for the same case and paired with the report's
 * sections. The page and PDF therefore read genuine prose and a real snapshot, with no provider.
 */

export type RenderResult = {
  view: ReadingPresentation;
  html: string;
  pdf: Buffer | null;
  /** Set when the local PDF worker failed; the HTML is still written. */
  pdfError: string | null;
  htmlPath: string;
  pdfPath: string | null;
  htmlBytes: number;
  pdfBytes: number;
  partial: boolean;
  wheelSystem: string | null;
  documentId: string;
};

export type RenderEditionOptions = {
  input: ChartInput;
  locale: Locale;
  profile: PaidProfile;
  results: SectionResult[];
  contentVersion: string;
  uiLocale: Locale;
  outDir: string;
  basename: string;
  keep?: boolean;
  /** Local inspection may allow a longer render than the production 15 s deadline. */
  pdfDeadlineMs?: number;
};

/**
 * The report's sections as the document builder expects them. Failed sections keep their status.
 * Cost, usage and latency are zeroed: the document is for layout, and its metrics are not evidence.
 */
export function reportSectionResults(report: PaidEvaluationReport, sample: EvaluationSample): SectionResult[] {
  return sample.sections.map(section => {
    if (section.status === "failed") {
      return { key: section.key, status: "failed", failureReason: "pilot_section_failed", costMxn: 0 };
    }
    return {
      key: section.key,
      status: "generated",
      fromCache: false,
      model: report.models[SECTION_MODEL_TIER[section.key]],
      usage: { inputTokens: 0, outputTokens: 0 },
      costMxn: 0,
      latencyMs: 0,
      output: {
        blocks: section.blocks,
        ...(section.closingQuestion !== undefined ? { closingQuestion: section.closingQuestion } : {}),
      },
    };
  });
}

export async function renderEdition(options: RenderEditionOptions): Promise<RenderResult> {
  const owner = await syntheticReadingAccount(options.locale, "none", { input: options.input });
  try {
    const edition = await syntheticPaidEdition(owner, options.locale, false, options.profile, {
      results: options.results,
      contentVersion: options.contentVersion,
      expectedInput: options.input,
    });
    const selector = { kind: "paid" as const, id: edition.document.id };
    const view = await loadReadingPresentation(owner.viewer, owner.chart.id, options.uiLocale, selector);
    if (view.content.kind !== "saved-reading") throw new Error("pilot_edition_not_readable");

    const html = renderToStaticMarkup(createElement(ReadingPageView, { view, locale: options.uiLocale, selector }));
    const response = await handleReadingPdf(
      new Request(`http://localhost/api/readings/${owner.chart.id}/pdf?paidEdition=${edition.document.id}`),
      owner.chart.id,
      {
        user: async () => owner.viewer,
        locale: options.uiLocale,
        throttle: async () => null,
        renderer: new ReadingPdfRenderer(options.pdfDeadlineMs ? { limits: { deadlineMs: options.pdfDeadlineMs } } : undefined),
      },
    );
    mkdirSync(options.outDir, { recursive: true });
    const htmlPath = path.join(options.outDir, `${options.basename}.html`);
    writeFileSync(htmlPath, html);

    let pdf: Buffer | null = null;
    let pdfError: string | null = null;
    let pdfPath: string | null = null;
    if (response.status === 200) {
      try {
        pdf = Buffer.from(await response.arrayBuffer());
        pdfPath = path.join(options.outDir, `${options.basename}.pdf`);
        writeFileSync(pdfPath, pdf);
      } catch {
        pdfError = "pdf_render_failed";
      }
    } else {
      // The local PDF worker is unreliable on this machine (known pdf_timeout); the page is still
      // the proof. CI runs the same render and is the authority for the PDF.
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      pdfError = body.code ?? `pdf_http_${response.status}`;
    }

    return {
      view,
      html,
      pdf,
      pdfError,
      htmlPath,
      pdfPath,
      htmlBytes: Buffer.byteLength(html),
      pdfBytes: pdf?.byteLength ?? 0,
      partial: view.content.partial,
      wheelSystem: view.wheelFacts?.houseSystem ?? null,
      documentId: edition.document.id,
    };
  } finally {
    if (!options.keep) await owner.cleanup();
  }
}

export async function renderReport(options: {
  reportPath: string;
  caseId?: string;
  uiLocale?: Locale;
  outDir: string;
  keep?: boolean;
  pdfDeadlineMs?: number;
}): Promise<RenderResult & { pilot: string; caseId: string; profile: PaidProfile; locale: Locale }> {
  const value = JSON.parse(readFileSync(options.reportPath, "utf8")) as unknown;
  const report = paidEvaluationSchema.parse(value);
  const pilot = path.basename(path.dirname(options.reportPath));
  const sample = (options.caseId ? report.samples.find(row => row.caseId === options.caseId) : undefined) ?? report.samples[0];
  if (!sample) throw new Error("pilot_sample_missing");
  const corpus = loadChartCorpus().find(entry => entry.id === sample.caseId);
  if (!corpus) throw new Error(`pilot_corpus_case_missing: ${sample.caseId}`);
  const uiLocale = options.uiLocale ?? (sample.locale === "es" ? "en" : "es");
  const result = await renderEdition({
    input: corpus.input,
    locale: sample.locale,
    profile: report.profile,
    results: reportSectionResults(report, sample),
    contentVersion: report.contentVersion,
    uiLocale,
    outDir: options.outDir,
    basename: `${pilot}-${sample.caseId}-${sample.locale}-${uiLocale}`,
    keep: options.keep,
    pdfDeadlineMs: options.pdfDeadlineMs,
  });
  return { ...result, pilot, caseId: sample.caseId, profile: report.profile, locale: sample.locale };
}
