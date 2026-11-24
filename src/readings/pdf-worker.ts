import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as renderer from "@react-pdf/renderer";
import { SolarReturnDocument } from "@/components/solar-pdf";
import { PDF_INPUT_BYTES, READING_LIMITS, sectionText } from "@/readings/presentation";
import { loadPdfFonts } from "@/readings/pdf-fonts";
import { PDF_IPC_CHUNK_BYTES, ReadingPdfError, type PdfWorkerMessage, type ReadingPdfInput } from "@/readings/pdf-contract";

const send = (message: PdfWorkerMessage) => new Promise<void>((resolve, reject) => {
  if (!process.send || !process.connected) return reject(new ReadingPdfError("pdf_aborted"));
  process.send(message, error => error ? reject(error) : resolve());
});
process.once("disconnect", () => process.exit(1));
process.once("message", async (message: { input: string }) => {
  let stream: NodeJS.ReadableStream | undefined;
  try {
    if (typeof message.input !== "string" || Buffer.byteLength(message.input) > PDF_INPUT_BYTES) throw new ReadingPdfError("pdf_input_limit");
    const input = JSON.parse(message.input) as ReadingPdfInput;
    const text = input.content.sections.flatMap(sectionText).reduce((sum, value) => sum + value.length, 0);
    if (input.content.sections.length > 11 || input.content.sections.some(section => section.blocks.length > 30) ||
      text > (input.content.kind === "saved-reading" && input.content.tier === "paid" ? READING_LIMITS.paidText : READING_LIMITS.freeText)) throw new ReadingPdfError("pdf_input_limit");
    await loadPdfFonts(renderer, join(dirname(fileURLToPath(import.meta.url)), "fonts"));
    let pages = 0;
    stream = await renderer.renderToStream(SolarReturnDocument({ ...input, renderer, onPageCount: value => { pages = value; } }));
    let size = 0; let buffered = 0; let chunks: Buffer[] = [];
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > READING_LIMITS.pdfBytes) throw new ReadingPdfError("pdf_output_limit");
      // A renderer stream chunk can itself exceed the IPC allowance. Split it
      // before sending, rather than flushing an arbitrarily large accumulation.
      for (let offset = 0; offset < bytes.length;) {
        const length = Math.min(PDF_IPC_CHUNK_BYTES - buffered, bytes.length - offset);
        chunks.push(bytes.subarray(offset, offset + length)); buffered += length; offset += length;
        if (buffered === PDF_IPC_CHUNK_BYTES) {
          await send({ kind: "chunk", bytes: Buffer.concat(chunks, buffered) }); chunks = []; buffered = 0;
        }
      }
    }
    if (buffered) await send({ kind: "chunk", bytes: Buffer.concat(chunks) });
    if (!pages) throw new ReadingPdfError("pdf_unavailable");
    await send({ kind: "done", pages, peakRss: process.resourceUsage().maxRSS * 1024 });
  } catch (error) {
    if (stream && "destroy" in stream && typeof stream.destroy === "function") stream.destroy();
    try { await send({ kind: "error", code: error instanceof ReadingPdfError ? error.code : "pdf_unavailable" }); }
    catch { /* Parent gone; the only remaining action is process teardown. */ }
  } finally { process.exit(0); }
});
