import { memoryExecution } from "./helpers/reading-execution";
import assert from "node:assert/strict";
import test from "node:test";
import { createChatAdapter, buildChatBody } from "../src/readings/adapters/chat-completions";
import { chartDigest } from "../src/lib/chart";
import { calculateSolarReturnChart } from "../src/lib/solar";
import { generateReadingDocument, MemorySectionCache } from "../src/readings/generate";
import type { ChartInput } from "../src/lib/types";
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
