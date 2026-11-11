import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatBody,
  ChatAdapterError,
  createChatAdapter,
  parseCompletionContent,
  stripCodeFence,
  toCompletion,
} from "../src/readings/adapters/chat-completions";
import { validUsage, type CompletionRequest } from "../src/readings/provider";
import { costMxn } from "../src/readings/config";
import { sectionJsonSchema, validateSectionOutput } from "../src/readings/schemas";

/*
 * The adapter's job is narrow and its failure modes are silent: a string where
 * the pipeline expects an object fails validation softly (fallback prose, no
 * error), and an invented usage number disables the cost ceiling. These tests
 * pin both.
 */

const request: CompletionRequest = {
  section: "overview",
  locale: "en",
  prompt: "WRAPPER\n\nbrief\n\n{\"sun\":{}}\n\nSCHEMA",
  digest: {} as CompletionRequest["digest"],
  jsonSchema: sectionJsonSchema("overview"),
  model: "test-model",
  maxOutputTokens: 2000,
};

const sampleOutput = {
  blocks: [{ kind: "prose", text: "A year that begins in the small rooms." }],
  closingQuestion: "What would you build there if this year had your back?",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function completionBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "vendor-model-1",
    choices: [{ message: { content: JSON.stringify(sampleOutput) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1234, completion_tokens: 456 },
    ...overrides,
  };
}

function adapter(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const provider = createChatAdapter({
    baseUrl: "https://example.invalid/v1/",
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return handler(String(url), init ?? {});
    },
  });
  return { provider, calls };
}

// ------------------------------------------------------------------ body

test("adapter: request body carries the assembled prompt, schema and token budget", () => {
  const body = buildChatBody(request);
  const messages = body.messages as Array<{ role: string; content: string }>;

  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, "user");
  assert.equal(messages[1].content, request.prompt, "the assembled prompt is passed through verbatim");
  assert.ok(messages[0].content.includes("JSON"));

  assert.equal(body.model, "test-model", "the pipeline's configured model wins");
  assert.ok((body.max_tokens as number) > request.maxOutputTokens, "headroom above the per-section cap");

  const format = body.response_format as {
    type: string;
    json_schema: { strict: boolean; schema: Record<string, unknown> };
  };
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(format.json_schema.schema, request.jsonSchema, "the real schema is sent, not a hand-rolled one");
});

test("adapter: schema sent is the pipeline's, and rejects a heading/blur vocabulary", () => {
  const schema = JSON.stringify(buildChatBody(request).response_format);
  assert.ok(schema.includes("prose"), "real block kinds appear in the schema");
  for (const invented of ["paragraph", "heading", "bullets", "highlight"]) {
    assert.equal(schema.includes(`"${invented}"`), false, `${invented} is not a real block kind`);
  }
});

// ------------------------------------------------------------------ parsing

test("adapter: fenced JSON is unwrapped; broken JSON returns the raw string", () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');

  assert.deepEqual(parseCompletionContent('```json\n{"a":1}\n```').output, { a: 1 });

  const broken = parseCompletionContent("Sure! Here is your reading: {...");
  assert.equal(typeof broken.output, "string", "a string, never {}, so validation names the real problem");
  const validation = validateSectionOutput("overview", broken.output);
  assert.equal(validation.ok, false);
});

test("adapter: successful response becomes a valid Completion and passes section validation", async () => {
  const { provider, calls } = adapter(async () => jsonResponse(completionBody()));
  const completion = await provider.complete(request);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.invalid/v1/chat/completions", "trailing slash normalised");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-key");

  assert.equal(completion.model, "vendor-model-1", "the served id is reported, not the requested one");
  assert.deepEqual(completion.usage, { inputTokens: 1234, outputTokens: 456 });
  assert.equal(validUsage(completion.usage), true);
  assert.ok(completion.latencyMs >= 0);

  const validation = validateSectionOutput("overview", completion.output);
  assert.equal(validation.ok, true, validation.ok ? "" : validation.error);
});

test("adapter: array-shaped content parts are joined", () => {
  const body = completionBody({
    choices: [{ message: { content: [{ text: '{"blocks":[' }, { text: '{"kind":"prose","text":"x"}]}' }] } }],
  });
  const completion = toCompletion(body, 5, "fallback");
  assert.deepEqual(completion.output, { blocks: [{ kind: "prose", text: "x" }] });
});

// ------------------------------------------------------------------ usage honesty

test("adapter: missing or non-numeric usage throws rather than booking a free call", () => {
  for (const usage of [undefined, {}, { prompt_tokens: 1 }, { prompt_tokens: "12", completion_tokens: 3 }, { prompt_tokens: -1, completion_tokens: 3 }]) {
    assert.throws(
      () => toCompletion(completionBody({ usage }), 1, "m"),
      (error: unknown) => error instanceof ChatAdapterError,
      `usage ${JSON.stringify(usage)} must not be defaulted to 0/0`,
    );
  }
});

test("adapter: reported usage prices under the real MXN table", () => {
  const priced = costMxn("fixture-1", { inputTokens: 1234, outputTokens: 456 });
  assert.ok(priced !== null && priced > 0);
  assert.equal(costMxn("vendor-model-1", { inputTokens: 1234, outputTokens: 456 }), null, "unpriced fails closed");
});

// ------------------------------------------------------------------ transport failures

test("adapter: HTTP failure, error object, and non-JSON body all throw ChatAdapterError", async () => {
  const cases: Array<[number, unknown]> = [
    [429, { error: { message: "rate limited" } }],
    [401, { error: { message: "bad key" } }],
  ];
  for (const [status, body] of cases) {
    const { provider } = adapter(async () => jsonResponse(body, status));
    await assert.rejects(() => provider.complete(request), (error: unknown) => {
      assert.ok(error instanceof ChatAdapterError);
      assert.equal(error.detail.status, status);
      assert.ok(!error.message.includes("test-key"), "never echo the key");
      return true;
    });
  }

  const { provider } = adapter(async () => new Response("<html>gateway</html>", { status: 200 }));
  await assert.rejects(() => provider.complete(request), /non-JSON response/);

  const noContent = adapter(async () => jsonResponse(completionBody({ choices: [{ message: {} }] })));
  await assert.rejects(() => noContent.provider.complete(request), /no message content/);
});

test("adapter: a timeout aborts instead of hanging the request", async () => {
  const provider = createChatAdapter({
    baseUrl: "https://example.invalid/v1",
    apiKey: "k",
    timeoutMs: 5,
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  await assert.rejects(() => provider.complete(request), /timed out after 5ms/);
});
