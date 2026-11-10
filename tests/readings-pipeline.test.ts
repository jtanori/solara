import assert from "node:assert/strict";
import test from "node:test";
import { calculateSolarReturnChart } from "../src/lib/solar";
import { chartDigest } from "../src/lib/chart";
import type { ChartInput } from "../src/lib/types";
import { SECTION_REGISTRY, availableSections, sectionsForTier } from "../src/readings/registry";
import { contentVersionFromSources, computeContentVersion, policyJson, resetContentVersionCacheForTests } from "../src/readings/content-version";
import { sectionJsonSchema, validateSectionOutput } from "../src/readings/schemas";
import { persistableDocument } from "../src/readings/document";
import { createFixtureProvider, validUsage, type ReadingProvider } from "../src/readings/provider";
import {
  MemorySectionCache,
  digestHashOf,
  generateReadingDocument,
  type SectionCache,
  type SectionCacheKey,
} from "../src/readings/generate";
import type { SectionKey, SectionTier } from "../src/readings/types";
import { costMxn, TIER_CEILING_MXN } from "../src/readings/config";

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

const ENV_KEYS = ["READINGS_GENERATION_ENABLED", "READINGS_PROVIDER", "READINGS_MODEL_PRICES", "READINGS_CHEAP_MODEL", "READINGS_STRONG_MODEL"] as const;

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

test("contentVersionFromSources: deterministic and sensitive to prompts, schemas, and policy", () => {
  const promptFiles = { "_wrapper.md": "wrapper", "overview.en.md": "brief-en", "overview.es.md": "brief-es" };
  const schemas = { overview: { type: "object" }, sun: { type: "object" } };
  const policy = JSON.stringify({ revision: "1", sectionModelTier: {}, models: { cheap: "fixture-1", strong: "fixture-1" } });
  const version = contentVersionFromSources(promptFiles, schemas, policy);
  assert.match(version, /^[0-9a-f]{16}$/);
  assert.equal(version, contentVersionFromSources(promptFiles, schemas, policy));
  // any prompt byte change → new version
  assert.notEqual(version, contentVersionFromSources({ ...promptFiles, "overview.en.md": "brief-en " }, schemas, policy));
  // any schema change → new version
  assert.notEqual(version, contentVersionFromSources(promptFiles, { ...schemas, sun: { type: "string" } }, policy));
  // any policy change — revision, section tiering, model swap, limits — → new version
  assert.notEqual(version, contentVersionFromSources(promptFiles, schemas, JSON.stringify({ revision: "1", sectionModelTier: {}, models: { cheap: "fixture-1", strong: "fixture-1" }, limits: { maxOutputTokensPerSection: 1000, tierCeilingMxn: { free: 5, paid: 10 } } })));
  assert.notEqual(version, contentVersionFromSources(promptFiles, schemas, JSON.stringify({ revision: "2", sectionModelTier: {}, models: { cheap: "fixture-1", strong: "fixture-1" } })));
  assert.notEqual(version, contentVersionFromSources(promptFiles, schemas, JSON.stringify({ revision: "1", sectionModelTier: { guidance: "strong" }, models: { cheap: "fixture-1", strong: "fixture-1" } })));
  assert.notEqual(version, contentVersionFromSources(promptFiles, schemas, JSON.stringify({ revision: "1", sectionModelTier: {}, models: { cheap: "fixture-1", strong: "other-model" } })));
  // key order does not matter (sources are sorted by name)
  assert.equal(version, contentVersionFromSources({ "overview.es.md": "brief-es", "_wrapper.md": "wrapper", "overview.en.md": "brief-en" }, schemas, policy));
});

test("policyJson: the versioned policy names tiering, models, and the spend limits", () => {
  const policy = JSON.parse(policyJson()) as {
    revision: string;
    sectionModelTier: Record<string, string>;
    models: { cheap: string; strong: string };
    limits: { maxOutputTokensPerSection: number; tierCeilingMxn: { free: number; paid: number } };
  };
  assert.equal(policy.sectionModelTier.guidance, "strong");
  assert.ok(policy.models.cheap && policy.models.strong);
  assert.equal(policy.limits.maxOutputTokensPerSection, 2000);
  assert.deepEqual(policy.limits.tierCeilingMxn, { free: 5, paid: 10 });
});

test("computeContentVersion: swapping the configured strong model changes the version", async () => {
  await withEnv({ READINGS_STRONG_MODEL: "model-a" }, async () => {
    const a = computeContentVersion();
    process.env.READINGS_STRONG_MODEL = "model-b";
    resetContentVersionCacheForTests();
    const b = computeContentVersion();
    assert.notEqual(a, b);
  });
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

test("validateSectionOutput: rejects unknown properties (top-level and nested) and missing cliffhanger", () => {
  const goodMoon = { blocks: [{ kind: "prose", text: "hi" }] };
  assert.ok(validateSectionOutput("moon", goodMoon).ok, "baseline: a valid moon output passes");
  // unknown TOP-LEVEL property, with valid blocks — isolates strictness from the min(1) rule
  assert.ok(!validateSectionOutput("moon", { ...goodMoon, extra: 1 }).ok, "unknown top-level properties rejected");
  // unknown property NESTED inside a block
  assert.ok(!validateSectionOutput("moon", { blocks: [{ kind: "prose", text: "hi", bogus: 1 }] }).ok, "unknown properties inside blocks rejected");
  // unknown block kind
  assert.ok(!validateSectionOutput("moon", { blocks: [{ kind: "hologram", text: "hi" }] }).ok, "unknown block kinds rejected");
  // the free sections must carry the cliffhanger
  assert.ok(!validateSectionOutput("overview", { blocks: [{ kind: "prose", text: "hi" }] }).ok, "missing closingQuestion rejected on overview");
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
    assert.equal(document.wastedCostMxn, 0);
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
    assert.equal(document.wastedCostMxn, 0);
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

test("accounting: a rescued repair counts BOTH attempts in spend, cache, and document", async () => {
  await withEnv({
    READINGS_GENERATION_ENABLED: "true",
    READINGS_MODEL_PRICES: JSON.stringify({ "fixture-1": { inputMxnPerMillion: 1, outputMxnPerMillion: 0 } }),
  }, async () => {
    // Every attempt reports a flat 1M input tokens ⇒ exactly 1 MXN per attempt.
    let overviewAttempts = 0;
    const metered: ReadingProvider = {
      name: "metered-repairable",
      async complete(request) {
        const inner = request.section === "overview" && ++overviewAttempts === 1 ? garbageProvider : createFixtureProvider();
        const completion = await inner.complete(request);
        return { ...completion, usage: { inputTokens: 1_000_000, outputTokens: 0 } };
      },
    };
    const cache = new MemorySectionCache();
    const document = await generate({ tier: "free", cache, provider: metered });
    assert.equal(overviewAttempts, 2, "one bad primary, one repair");
    const rows = cache.snapshot();
    const overviewRow = rows.find(row => row.key.section === "overview");
    const sunRow = rows.find(row => row.key.section === "sun");
    assert.ok(overviewRow && Math.abs(overviewRow.value.costMxn - 2) < 1e-6, `overview cache cost ${overviewRow?.value.costMxn} = primary + repair`);
    assert.ok(sunRow && Math.abs(sunRow.value.costMxn - 1) < 1e-6, `sun cache cost ${sunRow?.value.costMxn}`);
    assert.ok(Math.abs(document.costMxn - 3) < 1e-6, `document cost ${document.costMxn} includes the wasted primary`);
    assert.equal(document.wastedCostMxn, 0, "rescued attempts are published cost, not waste");
    assert.ok(document.sections.every(section => section.status === "generated"));
  });
});

test("pricing: unpriced model ⇒ no dispatch, fail closed", async () => {
  await withEnv({
    READINGS_GENERATION_ENABLED: "true",
    READINGS_MODEL_PRICES: JSON.stringify({ "some-other-model": { inputMxnPerMillion: 10, outputMxnPerMillion: 10 } }),
  }, async () => {
    const spy = spyAround(createFixtureProvider());
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: spy.provider });
    assert.equal(spy.calls.length, 0, "an unpriced model is never dispatched");
    for (const section of document.sections) {
      assert.equal(section.status, "failed");
      assert.match(section.failureReason ?? "", /^pricing_unavailable/);
    }
    assert.equal(document.costMxn, 0);
    assert.equal(document.wastedCostMxn, 0);
  });
});

test("pricing: invalid READINGS_MODEL_PRICES JSON ⇒ fail closed, never silent defaults", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true", READINGS_MODEL_PRICES: "not json at all" }, async () => {
    const spy = spyAround(createFixtureProvider());
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: spy.provider });
    assert.equal(spy.calls.length, 0);
    for (const section of document.sections) assert.match(section.failureReason ?? "", /^pricing_unavailable/);
  });
});

test("pricing: non-numeric price entries ⇒ fail closed", async () => {
  await withEnv({
    READINGS_GENERATION_ENABLED: "true",
    READINGS_MODEL_PRICES: JSON.stringify({ "fixture-1": { inputMxnPerMillion: "cheap", outputMxnPerMillion: 1 } }),
  }, async () => {
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: createFixtureProvider() });
    for (const section of document.sections) assert.match(section.failureReason ?? "", /^pricing_unavailable/);
  });
});

test("ceiling: every attempt counts — post-dispatch breach discards, accumulated spend gates later sections", async () => {
  await withEnv({
    READINGS_GENERATION_ENABLED: "true",
    READINGS_MODEL_PRICES: JSON.stringify({ "fixture-1": { inputMxnPerMillion: 2.2, outputMxnPerMillion: 0 } }),
  }, async () => {
    // Flat 1M input tokens per attempt ⇒ exactly 2.2 MXN per attempt.
    const metered: ReadingProvider = {
      name: "metered",
      async complete(request) {
        const completion = await createFixtureProvider().complete(request);
        return { ...completion, usage: { inputTokens: 1_000_000, outputTokens: 0 } };
      },
    };
    const document = await generate({ tier: "paid", cache: new MemorySectionCache(), provider: metered });
    const generated = document.sections.filter(section => section.status === "generated");
    const failed = document.sections.filter(section => section.status === "failed");
    assert.equal(generated.length, 4, "four 2.2-MXN sections fit the 10-MXN paid ceiling");
    assert.equal(failed.length, 5);
    assert.equal(failed.filter(section => section.failureReason === "cost_ceiling_exceeded_after_dispatch").length, 1, "the section whose actual spend crossed the ceiling is discarded after dispatch");
    assert.equal(failed.filter(section => (section.failureReason ?? "").startsWith("cost_ceiling:")).length, 4, "later sections are blocked pre-dispatch by accumulated spend");
    assert.ok(Math.abs(document.costMxn - 8.8) < 1e-6, `published cost ${document.costMxn}`);
    assert.ok(Math.abs(document.wastedCostMxn - 2.2) < 1e-6, `wasted cost ${document.wastedCostMxn}`);
  });
});

test("model tiering: guidance uses the strong model, everything else the cheap one", async () => {
  await withEnv({
    READINGS_GENERATION_ENABLED: "true",
    READINGS_CHEAP_MODEL: "cheap-x",
    READINGS_STRONG_MODEL: "strong-x",
    READINGS_MODEL_PRICES: JSON.stringify({
      "cheap-x": { inputMxnPerMillion: 15, outputMxnPerMillion: 60 },
      "strong-x": { inputMxnPerMillion: 15, outputMxnPerMillion: 60 },
    }),
  }, async () => {
    const document = await generate({ tier: "paid", cache: new MemorySectionCache(), provider: createFixtureProvider() });
    assert.equal(document.models.guidance, "strong-x");
    for (const key of ["overview", "sun", "moon", "ascendant", "aspects", "houses", "planets", "nodes"] as const) {
      assert.equal(document.models[key], "cheap-x", key);
    }
  });
});

test("persistableDocument: all-fallback and unversioned documents never occupy the insert-only slot", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const good = await generate({ tier: "free", cache: new MemorySectionCache(), provider: createFixtureProvider() });
    assert.ok(persistableDocument(good), "a document with generated content is persistable");
    const allFailed = await generate({ tier: "free", cache: new MemorySectionCache(), provider: garbageProvider });
    assert.ok(!persistableDocument(allFailed), "an all-fallback document must not block regeneration after an outage");
    assert.ok(!persistableDocument({ ...allFailed, contentVersion: "unavailable" }), "an unversioned document is never persistable");
  });
});

// ------------------------------------------------------------------ provider-reported usage is untrusted

test("usage validation: NaN token counts fail closed — output discarded, ceilings stay armed", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const nanUsage: ReadingProvider = {
      name: "nan-usage",
      async complete(request) {
        const completion = await createFixtureProvider().complete(request);
        return { ...completion, usage: { inputTokens: Number.NaN, outputTokens: Number.NaN } };
      },
    };
    const spy = spyAround(nanUsage);
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: spy.provider });
    assert.equal(spy.calls.length, 2, "one dispatch per section — then discarded");
    for (const section of document.sections) {
      assert.equal(section.status, "failed", `${section.key} discarded, not published on NaN usage`);
      assert.match(section.failureReason ?? "", /^usage_invalid/);
      assert.ok(section.blocks.length >= 1, "fallback blocks render");
    }
    assert.ok(Number.isFinite(document.costMxn), `document cost stays finite (${document.costMxn})`);
    assert.ok(Number.isFinite(document.wastedCostMxn), `wasted cost stays finite (${document.wastedCostMxn})`);
    assert.equal(document.costMxn, 0);
    // nothing was cached — a NaN completion must never be frozen
    const cache = new MemorySectionCache();
    await generate({ tier: "free", cache, provider: nanUsage });
    assert.equal(cache.size, 0);
  });
});

test("usage validation: negative token counts fail closed (no spend offsetting)", async () => {
  await withEnv({ READINGS_GENERATION_ENABLED: "true" }, async () => {
    const negativeUsage: ReadingProvider = {
      name: "negative-usage",
      async complete(request) {
        const completion = await createFixtureProvider().complete(request);
        return { ...completion, usage: { inputTokens: -5_000_000, outputTokens: 0 } };
      },
    };
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: negativeUsage });
    for (const section of document.sections) {
      assert.equal(section.status, "failed");
      assert.match(section.failureReason ?? "", /^usage_invalid/);
    }
    assert.equal(document.costMxn, 0, "negative usage cannot offset or create spend");
  });
});

test("usage validation: costMxn and validUsage treat bad usage as unpriceable", () => {
  assert.ok(validUsage({ inputTokens: 0, outputTokens: 0 }));
  assert.ok(validUsage({ inputTokens: 10, outputTokens: 20 }));
  assert.ok(!validUsage({ inputTokens: Number.NaN, outputTokens: 0 }));
  assert.ok(!validUsage({ inputTokens: 0, outputTokens: Number.NaN }));
  assert.ok(!validUsage({ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 }));
  assert.ok(!validUsage({ inputTokens: -1, outputTokens: 0 }));
  assert.ok(!validUsage({ inputTokens: 0, outputTokens: -1 }));
  assert.equal(costMxn("fixture-1", { inputTokens: Number.NaN, outputTokens: 1 }), null, "NaN usage is unpriceable, never NaN cost");
  assert.equal(costMxn("fixture-1", { inputTokens: -5, outputTokens: 1 }), null, "negative usage is unpriceable");
  assert.ok(costMxn("fixture-1", { inputTokens: 1_000_000, outputTokens: 0 }) !== null);
});

// ------------------------------------------------------------------ guards the review found untested

test("repair ceiling: a repair that would cross the ceiling is skipped, the section fails honestly", async () => {
  await withEnv({
    READINGS_GENERATION_ENABLED: "true",
    // Primary reports 1M input ⇒ 2.7 MXN; a repair at max output would cost
    // ~2.4 MXN more (output priced at 1200/M), crossing the 5-MXN free ceiling.
    READINGS_MODEL_PRICES: JSON.stringify({ "fixture-1": { inputMxnPerMillion: 2.7, outputMxnPerMillion: 1200 } }),
  }, async () => {
    let overviewAttempts = 0;
    const metered: ReadingProvider = {
      name: "repair-ceiling",
      async complete(request) {
        const inner = request.section === "overview" && ++overviewAttempts === 1 ? garbageProvider : createFixtureProvider();
        const completion = await inner.complete(request);
        return { ...completion, usage: { inputTokens: 1_000_000, outputTokens: 0 } };
      },
    };
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: metered });
    assert.equal(overviewAttempts, 1, "the repair is NOT dispatched once its projection crosses the ceiling");
    const overview = document.sections.find(section => section.key === "overview");
    assert.equal(overview?.status, "failed");
    assert.match(overview?.failureReason ?? "", /^cost_ceiling: repair projected/, `reason: ${overview?.failureReason}`);
    assert.ok(Math.abs((document.wastedCostMxn ?? 0) - 2.7) < 1e-6, `primary spend recorded as waste (${document.wastedCostMxn})`);
  });
});

test("pricing: negative price entries ⇒ fail closed", async () => {
  await withEnv({
    READINGS_GENERATION_ENABLED: "true",
    READINGS_MODEL_PRICES: JSON.stringify({ "fixture-1": { inputMxnPerMillion: -5, outputMxnPerMillion: 60 } }),
  }, async () => {
    const document = await generate({ tier: "free", cache: new MemorySectionCache(), provider: createFixtureProvider() });
    for (const section of document.sections) assert.match(section.failureReason ?? "", /^pricing_unavailable/, "a negative price is an invalid table, not a subsidy");
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
    assert.equal(document.costMxn, 0); // nothing was published
    assert.ok(document.wastedCostMxn > 0, `wasted attempt spend is recorded, not dropped (${document.wastedCostMxn})`);
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
    assert.equal(document.costMxn, 0);
    assert.equal(document.wastedCostMxn, 0, "a throw reports no usage, so no spend is invented");
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
    assert.equal(document.wastedCostMxn, 0);
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
    assert.equal(document.wastedCostMxn, 0);
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
