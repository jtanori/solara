import assert from "node:assert/strict";
import test from "node:test";
import { calculateSolarReturnChart } from "../src/lib/solar";
import { chartDigest } from "../src/lib/chart";
import type { ChartInput } from "../src/lib/types";
import { SECTION_REGISTRY, availableSections, sectionsForTier } from "../src/readings/registry";
import { contentVersionFromSources, computeContentVersion, resetContentVersionCacheForTests } from "../src/readings/content-version";
import { sectionJsonSchema, validateSectionOutput } from "../src/readings/schemas";
import { createFixtureProvider, type ReadingProvider } from "../src/readings/provider";
import {
  MemorySectionCache,
  digestHashOf,
  generateReadingDocument,
  type SectionCache,
  type SectionCacheKey,
} from "../src/readings/generate";
import type { SectionKey, SectionTier } from "../src/readings/types";
import { TIER_CEILING_MXN } from "../src/readings/config";

// The digest every test shares — the real pipeline input, computed once.
const baseInput: ChartInput = {
  name: "Pipeline Fixture",
  birthDate: "1984-05-16",
  birthTime: "01:00",
  birthPlace: { name: "Mexicali, Mexico", latitude: 32.6393, longitude: -115.4747, timezone: "America/Tijuana" },
  returnPlace: { name: "New York, United States", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" },
  year: 2026,
};
const baseDigest = chartDigest(calculateSolarReturnChart(baseInput).facts);

const ENV_KEYS = ["READINGS_GENERATION_ENABLED", "READINGS_PROVIDER", "READINGS_MODEL_PRICES"] as const;

async function withEnv(overrides: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetContentVersionCacheForTests();
    await run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

type RecordedCall = { section: SectionKey; locale: string; prompt: string; model: string };

function spyAround(inner: ReadingProvider): { provider: ReadingProvider; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    provider: {
      name: `spy(${inner.name})`,
      async complete(request) {
        calls.push({ section: request.section, locale: request.locale, prompt: request.prompt, model: request.model });
        return inner.complete(request);
      },
    },
  };
}

const throwingProvider: ReadingProvider = {
  name: "throwing",
  async complete() {
    throw new Error("provider exploded");
  },
};

const garbageProvider: ReadingProvider = {
  name: "garbage",
  async complete(request) {
    return { output: { nope: true }, usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, latencyMs: 1 };
  },
};

async function generate(args: Omit<Partial<Parameters<typeof generateReadingDocument>[0]>, "cache" | "tier"> & { tier: SectionTier; cache?: SectionCache }) {
  return generateReadingDocument({
    readingId: "00000000-0000-0000-0000-000000000001",
    locale: "en",
    digest: baseDigest,
    tier: args.tier,
    cache: args.cache ?? new MemorySectionCache(),
    ...(args.provider ? { provider: args.provider } : {}),
  });
}

// ------------------------------------------------------------------ registry

test("registry: free tier is overview + sun; paid tier gets everything", () => {
  assert.deepEqual(sectionsForTier("free"), ["overview", "sun"]);
  assert.equal(sectionsForTier("paid").length, 11);
  for (const key of sectionsForTier("paid")) assert.ok(SECTION_REGISTRY[key]);
});

test("registry: sections without engine facts are not available", () => {
  const available = availableSections(baseDigest);
  assert.ok(available.includes("guidance"));
  assert.ok(!available.includes("planetaryYear"));
  assert.ok(!available.includes("transits"));
  // #110 extends the digest; those sections light up without registry changes.
  const extended = { ...baseDigest, profections: { age: 42, lord: "Mars" }, transits: [] } as typeof baseDigest;
  const extendedAvailable = availableSections(extended);
  assert.ok(extendedAvailable.includes("planetaryYear"));
  assert.ok(extendedAvailable.includes("transits"));
  assert.equal(extendedAvailable.length, Object.keys(SECTION_REGISTRY).length);
});

// ------------------------------------------------------------------ content version

test("contentVersionFromSources: deterministic and sensitive to prompts and schemas", () => {
  const promptFiles = { "_wrapper.md": "wrapper", "overview.en.md": "brief-en", "overview.es.md": "brief-es" };
  const schemas = { overview: { type: "object" }, sun: { type: "object" } };
  const version = contentVersionFromSources(promptFiles, schemas);
  assert.match(version, /^[0-9a-f]{16}$/);
  assert.equal(version, contentVersionFromSources(promptFiles, schemas));
  // any prompt byte change → new version
  assert.notEqual(version, contentVersionFromSources({ ...promptFiles, "overview.en.md": "brief-en " }, schemas));
  // any schema change → new version
  assert.notEqual(version, contentVersionFromSources(promptFiles, { ...schemas, sun: { type: "string" } }));
  // key order does not matter (sources are sorted by name)
  assert.equal(version, contentVersionFromSources({ "overview.es.md": "brief-es", "_wrapper.md": "wrapper", "overview.en.md": "brief-en" }, schemas));
});

test("computeContentVersion: stable across calls and reads the real prompt files", () => {
  resetContentVersionCacheForTests();
  const first = computeContentVersion();
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(first, computeContentVersion());
  resetContentVersionCacheForTests();
  assert.equal(first, computeContentVersion());
});

// ------------------------------------------------------------------ schemas

test("sectionJsonSchema: strict objects, cliffhanger required only on free sections", () => {
  for (const key of ["overview", "sun", "moon"] as const) {
    const schema = sectionJsonSchema(key) as { additionalProperties?: boolean; required?: string[] };
    assert.equal(schema.additionalProperties, false, `${key} rejects unknown properties`);
    assert.deepEqual(schema.required, ["blocks", ...(key === "overview" || key === "sun" ? ["closingQuestion"] : [])], `${key} required fields`);
  }
  assert.deepEqual((sectionJsonSchema("moon") as { required: string[] }).required, ["blocks"], "moon's closingQuestion is optional");
});

test("fixture provider output validates for every available section in both locales", async () => {
  const fixture = createFixtureProvider();
  for (const key of availableSections(baseDigest)) {
    for (const locale of ["en", "es"] as const) {
      const completion = await fixture.complete({
        section: key,
        locale,
        prompt: "irrelevant for the fixture",
        digest: baseDigest,
        jsonSchema: sectionJsonSchema(key),
        model: "fixture-1",
        maxOutputTokens: 2000,
      });
      const validation = validateSectionOutput(key, completion.output);
      assert.ok(validation.ok, `${key}/${locale}: ${validation.ok ? "" : validation.error}`);
      if (key === "overview" || key === "sun") {
        assert.ok(validation.ok && validation.value.closingQuestion && validation.value.closingQuestion.length >= 10);
      }
    }
  }
});

test("validateSectionOutput: rejects unknown properties and missing cliffhanger", () => {
  assert.ok(!validateSectionOutput("moon", { blocks: [], extra: 1 }).ok);
  assert.ok(!validateSectionOutput("overview", { blocks: [{ kind: "prose", text: "hi" }] }).ok); // missing closingQuestion
  const okMoon = validateSectionOutput("moon", { blocks: [{ kind: "prose", text: "hi" }] });
  assert.ok(okMoon.ok);
});

// ------------------------------------------------------------------ memory cache

test("MemorySectionCache: roundtrip, locale and contentVersion are key dimensions, first write wins", async () => {
  const cache = new MemorySectionCache();
  const base: SectionCacheKey = { digestHash: "d1", section: "overview", locale: "en", contentVersion: "v1" };
  const value = { output: { blocks: [{ kind: "prose" as const, text: "x" }] }, model: "fixture-1", usage: { inputTokens: 1, outputTokens: 1 }, costMxn: 0.01, latencyMs: 5 };
  await cache.put(base, value);
  assert.deepEqual((await cache.get(base))?.output, value.output);
  assert.equal(await cache.get({ ...base, locale: "es" }), null, "locale is part of the cache key");
  assert.equal(await cache.get({ ...base, contentVersion: "v2" }), null, "contentVersion is part of the cache key");
  assert.equal(await cache.get({ ...base, digestHash: "d2" }), null, "digestHash is part of the cache key");
  assert.equal(await cache.get({ ...base, section: "sun" }), null, "section is part of the cache key");
  // freeze: a second put on the same key does not overwrite
  await cache.put(base, { ...value, model: "other" });
  assert.equal((await cache.get(base))?.model, "fixture-1");
});

// ------------------------------------------------------------------ cache keys reach the cache

test("generate: cache keys carry digestHash, section, locale, and the live contentVersion", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const seen: SectionCacheKey[] = [];
    const recording: SectionCache = {
      async get(key) {
        seen.push(structuredClone(key));
        return null;
      },
      async put() {},
    };
    const document = await generate({ tier: "free", cache: recording, provider: createFixtureProvider() });
    assert.equal(document.sections.length, 2);
    assert.equal(seen.length, 2); // one get per section (all misses)
    const contentVersion = computeContentVersion();
    for (const key of seen) {
      assert.equal(key.contentVersion, contentVersion);
      assert.equal(key.digestHash, digestHashOf(baseDigest));
      assert.equal(key.locale, "en");
      assert.ok(["overview", "sun"].includes(key.section));
    }
  });
});

// ------------------------------------------------------------------ kill switch

test("kill switch: unset flag ⇒ every section fails closed with generation_disabled", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: undefined }, async () => {
    const spy = spyAround(createFixtureProvider());
    const document = await generate({ tier: "paid", cache: new MemorySectionCache(), provider: spy.provider });
    assert.equal(document.sections.length, 9);
    for (const section of document.sections) {
      assert.equal(section.status, "failed");
      assert.equal(section.failureReason, "generation_disabled");
      assert.ok(section.blocks.length >= 1, "fallback blocks render");
    }
    assert.equal(spy.calls.length, 0, "no dispatch happens when disabled");
    assert.equal(document.costMxn, 0);
  });
});

// ------------------------------------------------------------------ provider resolution

test("enabled but no configured provider ⇒ provider_unavailable, never a throw", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true", READINGS_PROVIDER: undefined }, async () => {
    const document = await generate({ tier: "free", cache: new MemorySectionCache() });
    assert.equal(document.sections.length, 2);
    for (const section of document.sections) {
      assert.equal(section.status, "failed");
      assert.equal(section.failureReason, "provider_unavailable");
    }
  });
});

// ------------------------------------------------------------------ ceiling

test("cost ceiling: astronomic prices ⇒ pre-dispatch failure, zero spend, chart still renders", async () => {
  await withEnv({
    READINGS_GENERATION_ENABLED: "true",
    READINGS_MODEL_PRICES: JSON.stringify({ "fixture-1": { inputMxnPerMillion: 1e9, outputMxnPerMillion: 1e9 } }),
  }, async () => {
    const spy = spyAround(createFixtureProvider());
    const document = await generate({ tier: "paid", cache: new MemorySectionCache(), provider: spy.provider });
    assert.equal(spy.calls.length, 0, "nothing dispatched when the projection breaches the ceiling");
    assert.equal(document.costMxn, 0);
    for (const section of document.sections) {
      assert.equal(section.status, "failed");
      assert.match(section.failureReason ?? "", /^cost_ceiling/);
      assert.ok(section.blocks.length >= 1);
    }
  });
});

// ------------------------------------------------------------------ repair + fallback

test("validation: one repair attempt rescues a bad first response", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const fixture = createFixtureProvider();
    let overviewAttempts = 0;
    const repairable: ReadingProvider = {
      name: "repairable",
      async complete(request) {
        if (request.section === "overview") overviewAttempts += 1;
        if (request.section === "overview" && overviewAttempts === 1) return garbageProvider.complete(request);
        return fixture.complete(request);
      },
    };
    const cache = new MemorySectionCache();
    const document = await generate({ tier: "free", cache, provider: repairable });
    assert.equal(overviewAttempts, 2, "exactly one repair attempt for the bad section");
    for (const section of document.sections) {
      assert.equal(section.status, "generated");
    }
    assert.ok(document.sections.every(section => section.blocks.length >= 1));
    // the repaired section is cached like any other
    assert.equal(cache.size, 2);
  });
});

test("validation: unrepairable output ⇒ failed section with fallback, document survives", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    let calls = 0;
    const alwaysGarbage: ReadingProvider = {
      name: "always-garbage",
      async complete(request) {
        calls += 1;
        return garbageProvider.complete(request);
      },
    };
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: alwaysGarbage });
    assert.equal(calls, 4, "primary + repair for both sections");
    for (const section of document.sections) {
      assert.equal(section.status, "failed");
      assert.match(section.failureReason ?? "", /^invalid_output/);
      assert.ok(section.blocks.length >= 1, "fallback blocks render");
    }
    assert.equal(document.costMxn, 0);
  });
});

test("provider throw ⇒ provider_error, never a throw out of the pipeline", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: throwingProvider });
    for (const section of document.sections) {
      assert.equal(section.status, "failed");
      assert.match(section.failureReason ?? "", /^provider_error/);
      assert.ok(section.blocks.length >= 1);
    }
  });
});

// ------------------------------------------------------------------ document assembly

test("document: free tier shape, ordering, models, cost accounting, locked sections", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const spy = spyAround(createFixtureProvider());
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: spy.provider });
    assert.equal(document.tier, "free");
    assert.deepEqual(document.sections.map(section => section.key), ["overview", "sun"]);
    assert.deepEqual(document.lockedSections.map(section => section.key), ["moon", "ascendant", "aspects", "houses", "planets", "nodes", "guidance"]);
    assert.ok(document.models.overview && document.models.sun);
    assert.equal(spy.calls.length, 2);
    assert.ok(document.costMxn > 0 && document.costMxn <= TIER_CEILING_MXN.free);
    assert.equal(document.chartVersion, baseDigest.chartVersion);
    // free sections always end on the cliffhanger
    for (const section of document.sections) assert.ok(section.closingQuestion);
    // locked teasers are static copy, never model output
    for (const locked of document.lockedSections) {
      assert.ok(locked.title && locked.teaser);
      assert.equal(SECTION_REGISTRY[locked.key].tier, "paid");
    }
  });
});

test("document: paid tier generates every available paid section, none locked", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const document = await generate({ tier: "paid", cache: new MemorySectionCache(), provider: createFixtureProvider() });
    assert.deepEqual(
      document.sections.map(section => section.key),
      ["overview", "sun", "moon", "ascendant", "aspects", "houses", "planets", "nodes", "guidance"],
    );
    assert.equal(document.lockedSections.length, 0);
    assert.ok(document.costMxn > 0 && document.costMxn <= TIER_CEILING_MXN.paid);
    assert.equal(Object.keys(document.models).length, 9);
  });
});

test("document: cache hits are free and reuse frozen content without re-dispatch", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const cache = new MemorySectionCache();
    const first = await generate({ tier: "free", cache, provider: createFixtureProvider() });
    const spy = spyAround(createFixtureProvider());
    const second = await generate({ tier: "free", cache, provider: spy.provider });
    assert.equal(spy.calls.length, 0, "cache hit means no dispatch");
    assert.equal(second.costMxn, 0, "cache hits add no cost");
    assert.equal(second.sections.length, 2);
    assert.ok(second.sections.every(section => section.status === "generated"));
    assert.deepEqual(
      second.sections.map(section => section.blocks),
      first.sections.map(section => section.blocks),
      "frozen content is reused verbatim",
    );
    // per-section cost/latency were recorded at put time and survive
    const rows = cache.snapshot();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.value.usage.inputTokens > 0 && row.value.usage.outputTokens > 0);
      assert.ok(row.value.latencyMs > 0);
      assert.ok(row.value.costMxn > 0);
      assert.equal(row.value.model, "fixture-1");
    }
  });
});

// ------------------------------------------------------------------ prompt assembly

test("prompt: locale, digest, schema, brief, and the injection-defense contract", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    for (const locale of ["en", "es"] as const) {
      const spy = spyAround(createFixtureProvider());
      await generateReadingDocument({
        readingId: "00000000-0000-0000-0000-000000000002",
        locale,
        tier: "free",
        digest: baseDigest,
        cache: new MemorySectionCache(),
        provider: spy.provider,
      });
      assert.equal(spy.calls.length, 2);
      for (const call of spy.calls) {
        assert.ok(call.prompt.includes(locale === "es" ? "Español" : "English"));
        assert.ok(call.prompt.includes('"chartVersion"'), "digest JSON is embedded");
        assert.ok(call.prompt.includes('"blocks"'), "JSON Schema is embedded");
        assert.ok(call.prompt.includes(locale === "es" ? "Guía de sección" : "Section brief"), "per-locale brief file is loaded");
        assert.ok(call.prompt.includes("numeric and enumerated"), "injection-defense line present");
      }
    }
  });
});

test("prompt: Spanish sections get the Spanish brief", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const spy = spyAround(createFixtureProvider());
    await generateReadingDocument({
      readingId: "00000000-0000-0000-0000-000000000003",
      locale: "es",
      tier: "free",
      digest: baseDigest,
      cache: new MemorySectionCache(),
      provider: spy.provider,
    });
    for (const call of spy.calls) {
      assert.ok(call.prompt.includes("Guía de sección"), "Spanish brief file is loaded for es");
    }
  });
});
