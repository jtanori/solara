import type { Completion, CompletionRequest, PreparedCompletion, ReadingProvider } from "@/readings/provider";

/** Transport only: authorization/reservation is owned by generation-service/execution. */
export type ChatAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Verified processor contract: hard input-token caps, including all framing/schema. */
  inputTokenLimits?: Record<string, number>;
  /** OpenCode Go routes on a stable session id; sent as `x-opencode-session`. */
  sessionId?: string;
};

/** Safe diagnostic codes/status only. Never retain an upstream body or raw error. */
export class ChatAdapterError extends Error {
  constructor(message: string, readonly detail: { status?: number } = {}) {
    super(message); this.name = "ChatAdapterError";
  }
}

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
export type ChatMessage = { role: "system" | "user"; content: string };
export type ChatCompletionBody = Record<string, unknown>;

export function buildChatBody(request: CompletionRequest, model = request.model): ChatCompletionBody {
  return {
    model,
    messages: [
      { role: "system", content: "You reply with a single JSON object and nothing else. No prose before or after, no markdown fences." },
      { role: "user", content: request.prompt },
    ],
    // No hidden headroom: the reservation and the wire request share this cap.
    max_tokens: request.maxOutputTokens,
    temperature: 0.7,
    response_format: { type: "json_schema", json_schema: { name: `reading_${request.section}`, strict: true, schema: request.jsonSchema } },
  };
}

function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map(part => part && typeof part === "object" && typeof part.text === "string" ? part.text as string : null);
  return parts.length && parts.every(part => part !== null) ? parts.join("") : null;
}

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}
export type ParsedOutput = { output: unknown; raw: string };
export function parseCompletionContent(text: string): ParsedOutput {
  const raw = stripCodeFence(text);
  try { return { output: JSON.parse(raw) as unknown, raw }; }
  catch { return { output: raw, raw }; }
}

type ChatResponseBody = {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  model?: unknown;
  error?: unknown;
};

/** A missing body/output does not erase a valid usage receipt. No requested-model fallback. */
export function toCompletion(body: ChatResponseBody, latencyMs: number, _requestedModel?: string): Completion {
  if (!body || typeof body !== "object") throw new ChatAdapterError("provider returned an invalid response");
  const input = body.usage?.prompt_tokens;
  const output = body.usage?.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) ||
      input < 0 || output < 0 || !Number.isSafeInteger(input + output) || input + output === 0 ||
      (body.usage?.total_tokens !== undefined && body.usage.total_tokens !== input + output)) {
    throw new ChatAdapterError("provider returned no usable token usage");
  }
  const providerError = body.error !== undefined && body.error !== null;
  const text = providerError ? null : contentText(body.choices?.[0]?.message?.content);
  return {
    output: text === null ? null : parseCompletionContent(text).output,
    usage: { inputTokens: input, outputTokens: output },
    model: typeof body.model === "string" && /^[a-zA-Z0-9._:/-]{1,128}$/.test(body.model) ? body.model : "",
    latencyMs,
    ...(providerError ? { providerError: true } : {}),
  };
}

/** Abort also bounds injected transports/readers that do not implement cancellation themselves. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new ChatAdapterError("provider request aborted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new ChatAdapterError("provider response too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ChatAdapterError("provider response too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    // Do not await an uncooperative cancellation promise beyond the deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createChatAdapter(options: ChatAdapterOptions): ReadingProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) throw new ChatAdapterError("invalid provider timeout");
  const sessionId = options.sessionId?.trim();
  if (sessionId !== undefined && sessionId !== "" && !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) throw new ChatAdapterError("invalid provider session id");
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new ChatAdapterError("invalid provider endpoint");
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const doFetch = options.fetchImpl ?? fetch;

  function payload(request: CompletionRequest): string {
    if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 2000) throw new ChatAdapterError("invalid output cap");
    const body = JSON.stringify(buildChatBody(request));
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new ChatAdapterError("provider request too large");
    return body;
  }

  async function send(body: string, signal?: AbortSignal): Promise<Completion> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    // Elapsed transport time is independent of wall-clock synchronization.
    const started = performance.now();
    const elapsedMs = () => Math.max(0, Math.round(performance.now() - started));
    const timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      controller.signal.throwIfAborted();
      const response = await abortable(doFetch(endpoint, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}`, ...(sessionId ? { "x-opencode-session": sessionId } : {}) },
        body, signal: controller.signal,
      }), controller.signal);
      const text = await boundedBody(response, controller.signal);
      let parsed: ChatResponseBody;
      try { parsed = JSON.parse(text) as ChatResponseBody; }
      catch { throw new ChatAdapterError("provider returned a non-JSON response", { status: response.status }); }
      if (!response.ok) {
        // A non-success status is not evidence of zero billing. Keep a valid
        // receipt if supplied, but do not repair or continue an unhealthy provider.
        try { return { ...toCompletion(parsed, elapsedMs()), output: null, providerError: true }; }
        catch { throw new ChatAdapterError(`provider returned HTTP ${response.status}`, { status: response.status }); }
      }
      return toCompletion(parsed, elapsedMs());
    } catch (error) {
      if (controller.signal.aborted) throw new ChatAdapterError(`provider timed out or was aborted after at most ${timeoutMs}ms`);
      if (error instanceof ChatAdapterError) throw error;
      throw new ChatAdapterError("provider request failed");
    } finally {
      clearTimeout(timer); // Includes the entire body, not just response headers.
      signal?.removeEventListener("abort", cancel);
    }
  }

  return {
    name: "chat-completions",
    complete: (request, signal) => send(payload(request), signal),
    prepare(request): PreparedCompletion {
      const body = payload(request); // Serialize ONCE: the quoted bytes are the sent bytes.
      const inputTokens = options.inputTokenLimits?.[request.model];
      if (!Number.isSafeInteger(inputTokens) || inputTokens! < 1 || inputTokens! > 2_000_000) throw new ChatAdapterError("input metering contract unavailable");
      // Reserve the processor's FULL verified billable input cap. This includes
      // framing/system/schema tokens; it is not the old chars/4 estimate. Live
      // activation must verify these non-secret per-model contract limits.
      return { upperUsage: { inputTokens: inputTokens!, outputTokens: request.maxOutputTokens }, send: signal => send(body, signal) };
    },
  };
}

export function chatAdapterFromEnv(env: Record<string, string | undefined> = process.env): ReadingProvider | null {
  const baseUrl = env.READINGS_API_BASE_URL?.trim();
  const apiKey = env.READINGS_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  // Production orchestration supplies the validated processor/model contract.
  // The legacy resolver has no such contract and therefore cannot admit a call.
  return createChatAdapter({ baseUrl, apiKey, timeoutMs: env.READINGS_REQUEST_TIMEOUT_MS ? Number(env.READINGS_REQUEST_TIMEOUT_MS) : undefined, sessionId: env.READINGS_OPENCODE_SESSION });
}
