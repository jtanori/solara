import type { Completion, CompletionRequest, ReadingProvider } from "@/readings/provider";

/**
 * OpenAI-compatible chat-completions adapter (`docs/plan-readings-engine-epic.md`
 * §4.4, §9b). One implementation covers every vendor that speaks the
 * `/chat/completions` shape with a `response_format: json_schema` extension:
 * OpenAI, DeepSeek, Together, Groq, vLLM, Ollama's OpenAI shim. Vendor
 * differences are configuration, not code paths — base URL, key, and extra
 * headers come from the environment.
 *
 * The seam is `complete(request): Promise<Completion>` (provider.ts:36-39).
 * This module deliberately does NOT price anything: cost is computed downstream
 * from `config.ts:costMxn()` in MXN so the tier ceilings see real money. It also
 * never estimates usage — `usage` is the only pricing input the ledger has, and
 * an invented number disables the ceiling it is supposed to enforce.
 */

export type ChatAdapterOptions = {
  /** e.g. "https://api.openai.com/v1" — no trailing slash required. */
  baseUrl: string;
  apiKey: string;
  /** Sent as-is; some gateways require an attribution header. */
  extraHeaders?: Record<string, string>;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-attempt deadline. The pipeline has no timeout of its own. */
  timeoutMs?: number;
};

/** Thrown for anything the pipeline should surface as `provider_error`. */
export class ChatAdapterError extends Error {
  constructor(
    message: string,
    readonly detail: { status?: number; body?: string } = {},
  ) {
    super(message);
    this.name = "ChatAdapterError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Room for the JSON envelope around the section body. */
const MAX_TOKENS_HEADROOM = 256;

export type ChatMessage = { role: "system" | "user"; content: string };
export type ChatCompletionBody = Record<string, unknown>;

/**
 * Build the request body. Exported for tests: the shape here is the contract
 * the vendor sees, and it is the one thing that cannot be checked by reading
 * the pipeline.
 */
export function buildChatBody(request: CompletionRequest, model = request.model): ChatCompletionBody {
  /*
   * The assembled prompt (wrapper + brief + digest + schema, generate.ts:assemblePrompt)
   * is the user turn in full. It already contains the instruction to answer with
   * a single JSON object; the system turn exists so the schema requirement is
   * not buried mid-prompt in long charts.
   */
  return {
    model,
    messages: [
      {
        role: "system",
        content:
          "You reply with a single JSON object and nothing else. No prose before or after, no markdown fences.",
      },
      { role: "user", content: request.prompt },
    ],
    // The pipeline asks for at most MAX_OUTPUT_TOKENS_PER_SECTION; leave a little
    // room so a provider that counts the envelope separately does not truncate.
    max_tokens: request.maxOutputTokens + MAX_TOKENS_HEADROOM,
    temperature: 0.7,
    // json_schema keeps the model honest where supported; `strict` is honoured by
    // OpenAI and ignored by several compatible vendors, hence the parse fallback.
    response_format: {
      type: "json_schema",
      json_schema: { name: `reading_${request.section}`, strict: true, schema: request.jsonSchema },
    },
  };
}

/**
 * Tolerate the two shapes real vendors return for `content`: a plain string, and
 * an array of content parts (newer OpenAI responses, some gateways). Anything
 * else is a shape we do not understand and must not guess at.
 */
function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : null))
      .filter((part): part is string => part !== null);
    return parts.length ? parts.join("") : null;
  }
  return null;
}

/**
 * Strip a markdown fence. Models that honour "JSON only" still occasionally wrap
 * the object when the vendor ignores `response_format`. Removing the fence is
 * safe; guessing at broken JSON is not — that case must fall through to the
 * pipeline, whose single repair attempt re-asks with the validation error.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

export type ParsedOutput = { output: unknown; raw: string };

/**
 * Parse the model's answer into the `unknown` the pipeline validates.
 *
 * On parse failure we return the RAW STRING as `output`, not a fabricated `{}`.
 * `validateSectionOutput` then rejects it with a path-precise error
 * ("expected object, received string"), which is what the repair prompt quotes
 * back to the model. Returning `{}` would produce a schema error that names a
 * missing `blocks` key and teaches the model nothing about what went wrong.
 */
export function parseCompletionContent(text: string): ParsedOutput {
  const raw = stripCodeFence(text);
  try {
    return { output: JSON.parse(raw) as unknown, raw };
  } catch {
    return { output: raw, raw };
  }
}

type ChatResponseBody = {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  model?: unknown;
  error?: { message?: unknown; type?: unknown };
};

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Map the vendor response to `Completion`. Usage that is absent or non-numeric
 * throws rather than defaulting to 0: `validUsage()` would accept 0/0 and the
 * ledger would record a free call, so the honest failure is `provider_error`.
 */
export function toCompletion(body: ChatResponseBody, latencyMs: number, fallbackModel: string): Completion {
  const choice = body.choices?.[0];
  const text = contentText(choice?.message?.content);
  if (text === null) {
    throw new ChatAdapterError("provider returned no message content", {
      body: JSON.stringify(choice ?? null).slice(0, 500),
    });
  }

  const inputTokens = finiteCount(body.usage?.prompt_tokens);
  const outputTokens = finiteCount(body.usage?.completion_tokens);
  if (inputTokens === null || outputTokens === null) {
    throw new ChatAdapterError("provider returned no usable token usage", {
      body: JSON.stringify(body.usage ?? null).slice(0, 500),
    });
  }

  const { output } = parseCompletionContent(text);
  return {
    output,
    usage: { inputTokens, outputTokens },
    // Report what the vendor says it served: the ledger prices THIS id, and an
    // unpriced id halts the run instead of spending silently (generate.ts:account).
    model: typeof body.model === "string" && body.model ? body.model : fallbackModel,
    latencyMs,
  };
}

export function createChatAdapter(options: ChatAdapterOptions): ReadingProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    name: "chat-completions",
    async complete(request: CompletionRequest): Promise<Completion> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
            ...options.extraHeaders,
          },
          body: JSON.stringify(buildChatBody(request)),
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new ChatAdapterError(timedOut ? `provider timed out after ${timeoutMs}ms` : "provider request failed");
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      if (!response.ok) {
        throw new ChatAdapterError(`provider returned HTTP ${response.status}`, {
          status: response.status,
          // Enough to diagnose a bad model id or a rejected schema; the log
          // redactor strips keys and tokens (src/lib/log.ts).
          body: text.slice(0, 500),
        });
      }

      let body: ChatResponseBody;
      try {
        body = JSON.parse(text) as ChatResponseBody;
      } catch {
        throw new ChatAdapterError("provider returned a non-JSON response", { body: text.slice(0, 500) });
      }
      if (body.error) {
        throw new ChatAdapterError("provider returned an error object", {
          body: JSON.stringify(body.error).slice(0, 500),
        });
      }

      return toCompletion(body, Date.now() - startedAt, request.model);
    },
  };
}

/**
 * Optional convenience: read adapter config from the environment. Not called by
 * `PROVIDERS` — registration stays explicit (see provider.ts) so a missing key
 * is a startup decision, not a surprise inside a request.
 */
export function chatAdapterFromEnv(env: Record<string, string | undefined> = process.env): ReadingProvider | null {
  const baseUrl = env.READINGS_API_BASE_URL?.trim();
  const apiKey = env.READINGS_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return createChatAdapter({
    baseUrl,
    apiKey,
    timeoutMs: env.READINGS_REQUEST_TIMEOUT_MS ? Number(env.READINGS_REQUEST_TIMEOUT_MS) : undefined,
  });
}
