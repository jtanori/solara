import { memoryExecution } from "./helpers/reading-execution";
import assert from "node:assert/strict";
import test from "node:test";
import { createChatAdapter, buildChatBody } from "../src/readings/adapters/chat-completions";
import { chartDigest } from "../src/lib/chart";
import { calculateSolarReturnChart } from "../src/lib/solar";
import { generateReadingDocument, MemorySectionCache } from "../src/readings/generate";
import type { ChartInput } from "../src/lib/types";
import { dispatchAttempt, GenerationBlocked, type AttemptSettlement } from "../src/readings/execution";
import type { CompletionRequest } from "../src/readings/provider";

const input: ChartInput = {
  name: "Synthetic safety chart", birthDate: "1984-05-16", birthTime: "01:00", year: 2026,
  birthPlace: { name: "Mexicali", latitude: 32.6393, longitude: -115.4747, timezone: "America/Tijuana" },
  returnPlace: { name: "New York", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" },
};
const digest = chartDigest(calculateSolarReturnChart(input).facts);

for (const tier of ["free", "paid"] as const) {
  test(`#129 real adapter: missing usage halts ${tier} after one potentially billable call`, async () => {
    const previous = process.env.READINGS_GENERATION_ENABLED;
    process.env.READINGS_GENERATION_ENABLED = "true";
    let calls = 0;
    try {
      const provider = createChatAdapter({
        baseUrl: "https://example.invalid/v1", apiKey: "synthetic-key", inputTokenLimits: { "fixture-1": 3000 },
        fetchImpl: async () => {
          calls++;
          return Response.json({ model: "fixture-1", choices: [{ message: { content: "{}" } }] });
        },
      });
      const document = await generateReadingDocument({
        execution: memoryExecution(tier),
        readingId: "regression", locale: "en", tier, digest, cache: new MemorySectionCache(), provider,
      });
      assert.equal(calls, 1, "the adapter's thrown error cannot bypass the pipeline's halt");
      assert.ok(document.costMxn + document.wastedCostMxn > 0, "uncertain spend is not reported as free");
    } finally {
      if (previous === undefined) delete process.env.READINGS_GENERATION_ENABLED;
      else process.env.READINGS_GENERATION_ENABLED = previous;
    }
  });
}

test("adapter never enlarges the output cap admitted by the pipeline", () => {
  const request: CompletionRequest = {
    section: "overview", locale: "en", digest, prompt: "synthetic", jsonSchema: {},
    model: "fixture-1", maxOutputTokens: 2000,
  };
  assert.equal(buildChatBody(request).max_tokens, request.maxOutputTokens);
});

for (const tier of ["free", "paid"] as const) {
  test(`PR148 R1: a measured provider error halts the ${tier} pipeline without losing its receipt`, async () => {
    const previous = process.env.READINGS_GENERATION_ENABLED;
    process.env.READINGS_GENERATION_ENABLED = "true"; let calls = 0;
    try {
      const provider = createChatAdapter({
        baseUrl: "https://example.invalid/v1", apiKey: "synthetic-key", inputTokenLimits: { "fixture-1": 3000 },
        fetchImpl: async () => {
          calls++;
          return Response.json({ model: "fixture-1", usage: { prompt_tokens: 100, completion_tokens: 100 }, error: { message: "PRIVATE_PROVIDER_ERROR" } });
        },
      });
      const document = await generateReadingDocument({
        execution: memoryExecution(tier), readingId: "regression", locale: "en", tier, digest, cache: new MemorySectionCache(), provider,
      });
      assert.equal(calls, 1);
      assert.equal(document.accounting?.measuredMxn, 0.0075); assert.equal(document.accounting?.uncertainMxn, 0);
      assert.equal(document.wastedCostMxn, 0.0075); assert.equal(document.accounting?.halt, "provider_error");
      assert.equal(document.sections[0].failureReason, "provider_error");
      assert.equal(JSON.stringify(document).includes("PRIVATE_PROVIDER_ERROR"), false);
    } finally {
      if (previous === undefined) delete process.env.READINGS_GENERATION_ENABLED; else process.env.READINGS_GENERATION_ENABLED = previous;
    }
  });
}


for (const reason of ["consent_required", "generation_disabled", "generation_deadline", "generation_owner_lost", "permit_missing", "unexpected", "aborted"] as const) {
  test(`PR148 R5: unsent permit failure preserves ${reason} without releasing the offer`, async () => {
    const ledger = memoryExecution(); const controller = new AbortController(); let calls = 0;
    let settled: AttemptSettlement | undefined;
    const provider = createChatAdapter({
      baseUrl: "https://example.invalid/v1", apiKey: "synthetic", inputTokenLimits: { "fixture-1": 3000 },
      fetchImpl: async () => { calls++; throw new Error("must never send"); },
    });
    const execution = {
      ...ledger, signal: controller.signal,
      async assertPermit() {
        if (reason === "aborted") { controller.abort(); return; }
        if (reason === "unexpected") throw new Error("PRIVATE_PERMIT_ERROR");
        controller.abort(); // A precise authorization failure wins over concurrent cancellation.
        throw new GenerationBlocked(reason);
      },
      async settle(id: string, result: AttemptSettlement) { settled = result; return ledger.settle(id, result); },
    };
    const result = await dispatchAttempt(execution, provider, {
      section: "overview", locale: "en", digest, prompt: "synthetic", jsonSchema: {}, model: "fixture-1", maxOutputTokens: 2000,
    }, "primary");
    const code = reason === "unexpected" ? "generation_unavailable" : reason === "aborted" ? "generation_cancelled" : reason;
    assert.deepEqual(settled, { basis: "not_dispatched", costMicros: 0, model: null, usage: null, latencyMs: 0, code });
    assert.deepEqual(result, { measuredMicros: 0, uncertainMicros: 0, failure: code, halt: code });
    assert.equal(calls, 0);
    await assert.rejects(() => ledger.admit({ section: "overview", phase: "primary", model: "fixture-1", reservedMicros: 165000 }), /attempt_already_admitted/);
  });
}

for (const mode of ["measured", "unknown_model", "transport_error"] as const) {
  for (const elapsed of [12.6, -1]) {
    test(`PR148 R5: ${mode} settlement rounds/clamps monotonic delta ${elapsed}, independently of wall time`, async t => {
      const ledger = memoryExecution(); let settled: AttemptSettlement | undefined;
      let wallClock = 100_000; let monotonic = 100;
      t.mock.method(Date, "now", () => wallClock);
      t.mock.method(performance, "now", () => monotonic);
      const result = await dispatchAttempt({
        ...ledger,
        async settle(id, receipt) { settled = receipt; return ledger.settle(id, receipt); },
      }, {
        name: "synthetic-clock-test",
        async complete() {
          wallClock -= 60_000; monotonic += elapsed;
          if (mode === "transport_error") throw new Error("synthetic lost receipt");
          return { output: {}, usage: { inputTokens: 100, outputTokens: 100 }, model: mode === "unknown_model" ? "unpriced" : "fixture-1", latencyMs: 0 };
        },
      }, { section: "overview", locale: "en", digest, prompt: "synthetic", jsonSchema: {}, model: "fixture-1", maxOutputTokens: 2000 }, "primary");
      assert.equal(settled?.basis, mode === "measured" ? "measured" : "unknown");
      assert.equal(settled?.latencyMs, elapsed < 0 ? 0 : 13);
      assert.equal(result.ledgerFailed, undefined);
      assert.ok((settled?.costMicros ?? 0) > 0);
    });
  }
}
