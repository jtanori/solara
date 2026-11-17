import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDF_FAILURE_CODES, PDF_IPC_CHUNK_BYTES, PDF_WORKER_HEAP_MB, PDF_WORKER_RSS_BYTES, ReadingPdfError, type PdfFailureCode, type PdfWorkerMessage, type ReadingPdfInput } from "@/readings/pdf-contract";
import { READING_LIMITS, sectionText } from "@/readings/presentation";

if (typeof window !== "undefined") throw new Error("pdf-render is server-only");

type Limits = { deadlineMs: number; outputBytes: number; rssBytes: number };
type ChildFactory = (path: string, options: Parameters<typeof fork>[2]) => ChildProcess;
export type PdfRenderResult = { buffer: Buffer; pages: number; peakRss: number; durationMs: number };

/** One active process, zero queue. Tests may tighten limits/inject a real fixture
 * child; HTTP clients can never set paths, resource limits or worker options. */
export class ReadingPdfRenderer {
  private active = false;
  constructor(private readonly options: { directory?: string; limits?: Partial<Limits>; spawn?: ChildFactory } = {}) {}

  async render(input: ReadingPdfInput, signal?: AbortSignal): Promise<PdfRenderResult> {
    if (this.active) throw new ReadingPdfError("pdf_capacity");
    if (signal?.aborted) throw new ReadingPdfError("pdf_aborted");
    const serialized = JSON.stringify({ chart: input.chart, content: input.content });
    const textLength = input.content.sections.flatMap(sectionText).reduce((sum, text) => sum + text.length, 0);
    if (Buffer.byteLength(serialized) > READING_LIMITS.documentBytes + READING_LIMITS.chartBytes ||
      input.content.sections.length > 11 || input.content.sections.some(section => section.blocks.length > 30) ||
      textLength > (input.content.kind === "saved-reading" && input.content.tier === "paid" ? READING_LIMITS.paidText : READING_LIMITS.freeText)) throw new ReadingPdfError("pdf_input_limit");
    const limits = { deadlineMs: READING_LIMITS.pdfDeadlineMs, outputBytes: READING_LIMITS.pdfBytes, rssBytes: PDF_WORKER_RSS_BYTES, ...this.options.limits };
    // A statically scoped default prevents Turbopack from tracing the repository.
    // The optional absolute directory exists only for packaged-worker tests.
    const directory = this.options.directory ?? join(process.cwd(), ".pdf");
    this.active = true;
    const started = performance.now();
    let child: ChildProcess;
    try {
      child = (this.options.spawn ?? ((path, options) => fork(path, [], options)))(`${directory}/bootstrap.mjs`, {
        cwd: directory, env: { NODE_ENV: "production", TZ: "UTC", LANG: "C.UTF-8" },
        execArgv: [`--max-old-space-size=${PDF_WORKER_HEAP_MB}`, "--permission", `--allow-fs-read=${directory}`, "--no-warnings"],
        stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
      });
    } catch { this.active = false; throw new ReadingPdfError("pdf_unavailable"); }
    return await new Promise<PdfRenderResult>((resolveResult, reject) => {
      const chunks: Buffer[] = []; let bytes = 0; let pages = 0; let peakRss = 0;
      let error: PdfFailureCode | null = null; let done = false;
      const terminate = (code: PdfFailureCode) => {
        error ??= code;
        // Never resolve/release the slot here. Wait for `close`, including IPC.
        child.kill("SIGKILL");
      };
      const abort = () => terminate("pdf_aborted");
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => terminate("pdf_timeout"), limits.deadlineMs);
      let measuring = false;
      const memory = setInterval(async () => {
        if (measuring || !child.pid) return;
        measuring = true;
        try {
          // Linux production hosts: external sampling also runs during blocked
          // Yoga/layout JS. Heap cap applies on every supported platform.
          const status = await readFile(`/proc/${child.pid}/status`, "utf8");
          const rss = Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024;
          peakRss = Math.max(peakRss, rss);
          if (rss > limits.rssBytes) terminate("pdf_memory_limit");
        } catch { /* Child may already have exited; close handles final outcome. */ }
        finally { measuring = false; }
      }, 50);
      child.on("message", (message: PdfWorkerMessage) => {
        if (error || done) return;
        if (message?.kind === "chunk" && message.bytes instanceof Uint8Array) {
          bytes += message.bytes.byteLength;
          if (bytes > limits.outputBytes || message.bytes.byteLength > PDF_IPC_CHUNK_BYTES) return terminate("pdf_output_limit");
          chunks.push(Buffer.from(message.bytes));
        } else if (message?.kind === "done" && Number.isInteger(message.pages) && Number.isFinite(message.peakRss)) {
          pages = message.pages; peakRss = Math.max(peakRss, message.peakRss); done = true;
          if (pages < 1 || pages > (input.content.kind === "saved-reading" && input.content.tier === "paid" ? READING_LIMITS.paidPdfPages : READING_LIMITS.pdfPages)) terminate("pdf_page_limit");
          else if (peakRss > limits.rssBytes) terminate("pdf_memory_limit");
        } else terminate(message?.kind === "error" && PDF_FAILURE_CODES.includes(message.code) ? message.code : "pdf_unavailable");
      });
      child.on("error", () => terminate("pdf_unavailable"));
      child.once("close", code => {
        clearTimeout(timeout); clearInterval(memory); signal?.removeEventListener("abort", abort);
        this.active = false;
        if (error || code !== 0 || !done || !bytes) return reject(new ReadingPdfError(error ?? "pdf_unavailable"));
        resolveResult({ buffer: Buffer.concat(chunks, bytes), pages, peakRss, durationMs: performance.now() - started });
      });
      if (signal?.aborted) abort();
      else {
        try { child.send({ input: serialized }, sendError => { if (sendError) terminate("pdf_unavailable"); }); }
        catch { terminate("pdf_unavailable"); }
      }
    });
  }
}

// Only coordination is global, never document data or buffers. Also survives
// duplicated Next module graphs in one process without multiplying render slots.
const scope = globalThis as typeof globalThis & { solaraPdfRenderer?: ReadingPdfRenderer };
export const readingPdfRenderer = scope.solaraPdfRenderer ??= new ReadingPdfRenderer();
