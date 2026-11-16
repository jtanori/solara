import assert from "node:assert/strict";
import test from "node:test";
import { createChatAdapter, MAX_RESPONSE_BYTES, toCompletion } from "../src/readings/adapters/chat-completions";
import { outboundDigest } from "../src/readings/outbound-digest";
import { chartDigest } from "../src/lib/chart";
import { calculateSolarReturnChart } from "../src/lib/solar";
import { liveGenerationConfig, processorProfile } from "../src/readings/policy";
import { computeContentVersion, resetContentVersionCacheForTests } from "../src/readings/content-version";
import type { CompletionRequest } from "../src/readings/provider";
import type { ChartInput } from "../src/lib/types";

const input: ChartInput = { name: "Synthetic", birthDate: "1984-05-16", birthTime: "01:00", year: 2026, birthPlace: { name: "Mexicali", latitude: 32.6393, longitude: -115.4747, timezone: "America/Tijuana" }, returnPlace: { name: "New York", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" } };
const digest = chartDigest(calculateSolarReturnChart(input).facts);
const request: CompletionRequest = { section: "overview", locale: "en", digest, prompt: "synthetic original", jsonSchema: { type: "object" }, model: "synthetic-model", maxOutputTokens: 2000 };
const responseBody = { model: "synthetic-model", usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }, choices: [{ message: { content: "{}" } }] };

test("transport: timer covers a stalled body AFTER headers and cancellation reaches the reader", async () => {
  let cancelled = false; let signal: AbortSignal | undefined;
  const provider = createChatAdapter({ baseUrl: "https://processor.invalid/v1", apiKey: "fake", timeoutMs: 10,
    fetchImpl: async (_url, init) => { signal = init!.signal!; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); },
  });
  const cancellation = new AbortController();
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await assert.rejects(() => Promise.race([
      provider.complete(request, cancellation.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("adapter missed body deadline")), 250); }),
    ]), /timed out/);
    assert.equal(signal?.aborted, true); assert.equal(cancelled, true);
  } finally { clearTimeout(timer); cancellation.abort(); }
});

test("transport: reject oversized bodies, cancel reader, and never retain provider body text", async () => {
  let cancelled = false;
  const provider = createChatAdapter({ baseUrl: "https://processor.invalid/v1", apiKey: "FAKE_KEY_SENTINEL",
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("PRIVATE_BODY_SENTINEL".repeat(Math.ceil(MAX_RESPONSE_BYTES / 20) + 1))); },
      cancel() { cancelled = true; },
    })),
  });
  await assert.rejects(() => provider.complete(request), error => {
    assert.match(String(error), /response too large/);
    assert.equal(JSON.stringify(error).includes("PRIVATE_BODY_SENTINEL"), false);
    assert.equal(String(error).includes("FAKE_KEY_SENTINEL"), false); return true;
  });
  assert.equal(cancelled, true);
});

test("transport: quote and send use the same prepared payload, exact output cap, full input contract, no redirects", async () => {
  let sent = ""; let redirects = "";
  const provider = createChatAdapter({ baseUrl: "https://processor.invalid/v1", apiKey: "fake", inputTokenLimits: { "synthetic-model": 128000 },
    fetchImpl: async (_url, init) => { sent = String(init!.body); redirects = init!.redirect!; return Response.json(responseBody); },
  });
  const mutable = structuredClone(request);
  const prepared = provider.prepare!(mutable);
  assert.deepEqual(prepared.upperUsage, { inputTokens: 128000, outputTokens: 2000 });
  mutable.prompt = "SHOULD_NOT_LEAVE"; mutable.maxOutputTokens = 4000;
  await prepared.send();
  assert.equal(sent.includes("SHOULD_NOT_LEAVE"), false);
  const body = JSON.parse(sent); assert.equal(body.max_tokens, 2000);
  assert.equal(body.messages[0].role, "system"); assert.deepEqual(body.response_format.json_schema.schema, request.jsonSchema);
  assert.equal(redirects, "error");
});

test("transport: unknown input contract, invalid timeout and credential-bearing endpoints fail before send", () => {
  let calls = 0;
  const options = { baseUrl: "https://processor.invalid/v1", apiKey: "fake", fetchImpl: async () => { calls++; return Response.json(responseBody); } };
  const provider = createChatAdapter(options);
  assert.throws(() => provider.prepare!(request), /metering contract unavailable/);
  for (const timeoutMs of [0, -1, Infinity, NaN, 15001, 0.5]) assert.throws(() => createChatAdapter({ ...options, timeoutMs }), /invalid provider timeout/);
  for (const baseUrl of ["http://processor.invalid", "https://secret@processor.invalid", "https://processor.invalid?api_key=secret", "https://processor.invalid#secret"]) assert.throws(() => createChatAdapter({ ...options, baseUrl }), /invalid provider endpoint/);
  assert.equal(calls, 0);
});

test("transport: usage must be complete safe integers, consistent, nonzero; no missing-model substitution", () => {
  for (const usage of [null, {}, { prompt_tokens: true, completion_tokens: 1 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }, { prompt_tokens: 0, completion_tokens: 0 }, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 6 }]) {
    assert.throws(() => toCompletion({ ...responseBody, usage } as never, 1, "requested"), /no usable token usage/);
  }
  assert.equal(toCompletion({ ...responseBody, model: undefined }, 1, "requested").model, "");
  const measuredError = toCompletion({ ...responseBody, choices: undefined, error: { message: "PRIVATE_ERROR_SENTINEL" } }, 1);
  assert.equal(measuredError.output, null); assert.deepEqual(measuredError.usage, { inputTokens: 2, outputTokens: 3 });
  assert.equal(JSON.stringify(measuredError).includes("PRIVATE_ERROR_SENTINEL"), false);
});

test("outbound digest drops unknown fields and warning strings, rejects injected chart-value text", () => {
  const polluted = { ...digest, email: "PRIVATE_EMAIL_SENTINEL", warnings: ["PRIVATE_WARNING_SENTINEL"], sun: { ...digest.sun, name: "PRIVATE_NAME_SENTINEL" } };
  const safe = outboundDigest(polluted);
  const text = JSON.stringify(safe);
  for (const leak of ["PRIVATE_EMAIL_SENTINEL", "PRIVATE_WARNING_SENTINEL", "PRIVATE_NAME_SENTINEL"]) assert.equal(text.includes(leak), false);
  assert.deepEqual(safe.warnings, ["chart_calculation_limitations"]);
  assert.throws(() => outboundDigest({ ...digest, sun: { ...digest.sun, sign: "arbitrary user text" } }));
});

test("processor swap changes consent/cache identity; invalid or incomplete profile has no live fallback", () => {
  const keys = ["READINGS_PROVIDER", "READINGS_PROCESSOR_PROFILE", "READINGS_API_BASE_URL", "READINGS_CHEAP_MODEL", "READINGS_API_KEY", "READINGS_MODEL_PRICES"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    const profile = { id: "synthetic-one", name: "Synthetic One", policyVersion: "v1", inputTokenLimits: { model: 10000 }, servedModels: { model: ["model"] } };
    Object.assign(process.env, { READINGS_PROVIDER: "chat-completions", READINGS_PROCESSOR_PROFILE: JSON.stringify(profile), READINGS_API_BASE_URL: "https://one.invalid/v1" });
    const first = processorProfile(); assert.ok(first);
    resetContentVersionCacheForTests(); const version = computeContentVersion();
    process.env.READINGS_API_BASE_URL = "https://two.invalid/v1";
    assert.notEqual(processorProfile()?.policyHash, first.policyHash);
    resetContentVersionCacheForTests(); assert.notEqual(computeContentVersion(), version);
    delete process.env.READINGS_CHEAP_MODEL; delete process.env.READINGS_MODEL_PRICES;
    assert.equal(liveGenerationConfig(), null, "no fixture model/rates for account generation");
    process.env.READINGS_PROCESSOR_PROFILE = JSON.stringify({ ...profile, unexpected: "PRIVATE_SECRET_SENTINEL" });
    assert.equal(processorProfile(), null);
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    resetContentVersionCacheForTests();
  }
});
