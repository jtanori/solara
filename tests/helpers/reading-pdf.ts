import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { calculateSolarReturn } from "../../src/lib/solar";
import { readStoredDocument } from "../../src/readings/stored-document";
import type { ReadingPdfInput } from "../../src/readings/pdf-contract";
import { documentIdentity, frozenReading, readingChartInput } from "./reading-fixtures";

export function pdfFixture(locale: "en" | "es" = "en", edition: Parameters<typeof frozenReading>[1] = "free"): ReadingPdfInput {
  const document = frozenReading(locale, edition);
  const decoded = readStoredDocument(JSON.stringify(document), documentIdentity(document), { allowPaid: true });
  assert.ok(decoded.ok);
  return { content: decoded.value, chart: { id: document.readingId!, name: readingChartInput.name, year: readingChartInput.year, returnPlace: readingChartInput.returnPlace.name, timezone: readingChartInput.returnPlace.timezone, result: calculateSolarReturn(readingChartInput) } };
}
export const normalizePdfText = (text: string) => text.replace(/\s+/gu, " ").trim();
export async function inspectPdf(buffer: Buffer, raster = false) {
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: false,
    standardFontDataUrl: `${resolve("node_modules/pdfjs-dist/standard_fonts")}/`, });
  const pdf = await loading.promise;
  try {
    const metadata = (await pdf.getMetadata()).info as { Title: string; Language: string; CreationDate: string };
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number); const content = await page.getTextContent();
      const items = content.items.filter(item => "str" in item).map(item => {
        assert.ok("str" in item);
        return { text: item.str, x: item.transform[4], y: page.view[3] - item.transform[5], width: item.width, height: item.height };
      });
      const body = items.filter(item => item.y > 65 && item.y < 782);
      let image: Buffer | null = null;
      if (raster) {
        const viewport = page.getViewport({ scale: 96 / 72 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D, viewport }).promise;
        image = canvas.toBuffer("image/png");
      }
      pages.push({ annotations: await page.getAnnotations(), text: normalizePdfText(body.map(item => item.text).join(" ")), allText: normalizePdfText(items.map(item => item.text).join(" ")), items,
        visual: image ? createHash("sha256").update(image).digest("hex") : null, image });
    }
    return { metadata, pages, text: normalizePdfText(pages.map(page => page.text).join(" ")) };
  } finally { await loading.destroy(); }
}
