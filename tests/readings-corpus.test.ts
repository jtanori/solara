import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { calculateSolarReturnChart } from "../src/lib/solar";
import { chartDigest, type ChartDigest } from "../src/lib/chart";
import type { ChartInput } from "../src/lib/types";
import { createFixtureProvider, type ReadingProvider } from "../src/readings/provider";
import { generateReadingDocument, MemorySectionCache } from "../src/readings/generate";
import { validateSectionOutput } from "../src/readings/schemas";
import { TIER_CEILING_MXN } from "../src/readings/config";
import type { Locale } from "../src/lib/i18n";

/**
 * The #103 acceptance test: a corpus of sample charts, both locales, end to
 * end through the real pipeline with the fixture provider and a shared cache —
 * the way production will run it, minus the LLM.
 *
 * Asserts: 100% schema validity, per-section cost + latency recorded, digest
 * budget respected, per-document cost under the tier ceiling, cache reuse
 * without re-dispatch, locale separation, and forced provider failure that
 * degrades to fallback instead of throwing.
 */

// Env hygiene: enable generation for this file's tests only, and restore it
// afterwards — module-level mutation without restore leaks into anything that
// shares this process.
before(() => {
  process.env.READINGS_GENERATION_ENABLED = "true";
});
after(() => {
  delete process.env.READINGS_GENERATION_ENABLED;
});

const INPUTS: ChartInput[] = [
  {
    name: "Corpus One",
    birthDate: "1984-05-16",
    birthTime: "01:00",
    birthPlace: { name: "Mexicali, Mexico", latitude: 32.6393, longitude: -115.4747, timezone: "America/Tijuana" },
    returnPlace: { name: "New York, United States", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" },
    year: 2026,
  },
  {
    name: "Corpus Two",
    birthDate: "1990-11-02",
    birthTime: "07:30",
    birthPlace: { name: "Madrid, Spain", latitude: 40.4168, longitude: -3.7038, timezone: "Europe/Madrid" },
    returnPlace: { name: "Madrid, Spain", latitude: 40.4168, longitude: -3.7038, timezone: "Europe/Madrid" },
    year: 2027,
  },
  {
    name: "Corpus Three",
    birthDate: "1975-02-09",
    birthTime: "18:45",
    birthPlace: { name: "Buenos Aires, Argentina", latitude: -34.6037, longitude: -58.3816, timezone: "America/Argentina/Buenos_Aires" },
    returnPlace: { name: "Ciudad de México, Mexico", latitude: 19.4326, longitude: -99.1332, timezone: "America/Mexico_City" },
    year: 2026,
  },
  {
    name: "Corpus Four",
    birthDate: "2001-06-21",
    birthTime: "12:15",
    birthPlace: { name: "Tokyo, Japan", latitude: 35.6762, longitude: 139.6503, timezone: "Asia/Tokyo" },
    returnPlace: { name: "Los Angeles, United States", latitude: 34.0522, longitude: -118.2437, timezone: "America/Los_Angeles" },
    year: 2026,
  },
  {
    name: "Corpus Five",
    birthDate: "1968-09-30",
    birthTime: "03:00",
    birthPlace: { name: "Reykjavík, Iceland", latitude: 64.1466, longitude: -21.9426, timezone: "Atlantic/Reykjavik" },
    returnPlace: { name: "Lisbon, Portugal", latitude: 38.7223, longitude: -9.1393, timezone: "Europe/Lisbon" },
    year: 2026,
  },
  {
    name: "Corpus Six",
    birthDate: "1995-12-05",
    birthTime: "22:20",
    birthPlace: { name: "Hermosillo, Mexico", latitude: 29.0729, longitude: -110.9559, timezone: "America/Hermosillo" },
    returnPlace: { name: "Puerto Peñasco, Mexico", latitude: 31.3333, longitude: -113.5, timezone: "America/Hermosillo" },
    year: 2027,
  },
];

const LOCALES: Locale[] = ["en", "es"];

const throwingProvider: ReadingProvider = {
  name: "throwing",
  async complete() {
    throw new Error("simulated provider outage");
  },
};

const garbageProvider: ReadingProvider = {
  name: "garbage",
  async complete(request) {
    return { output: { blocks: "not-an-array" }, usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, latencyMs: 1 };
  },
};

test("corpus: charts × locales through the pipeline — validity, cost, latency, budget, ceilings", async () => {
  const cache = new MemorySectionCache();
  const digests: ChartDigest[] = [];
  for (const input of INPUTS) {
    const digest = chartDigest(calculateSolarReturnChart(input).facts);
    const serialized = JSON.stringify(digest);
    assert.ok(serialized.length < 8000, `digest budget: ${serialized.length} chars for ${input.name}`);
    digests.push(digest);
  }
  assert.equal(new Set(digests.map(digest => JSON.stringify(digest))).size, INPUTS.length, "corpus charts have distinct digests");

  const costByLocale: Record<Locale, number> = { en: 0, es: 0 };
  let generatedSections = 0;

  for (const [index, digest] of digests.entries()) {
    for (const locale of LOCALES) {
      const spyCalls: string[] = [];
      const spy: ReadingProvider = {
        name: "spy",
        async complete(request) {
          spyCalls.push(request.section);
          return createFixtureProvider().complete(request);
        },
      };
      const document = await generateReadingDocument({
        readingId: `corpus-${index}-${locale}`,
        locale,
        tier: "free",
        digest,
        cache,
        provider: spy,
      });

      // free tier shape
      assert.deepEqual(document.sections.map(section => section.key), ["overview", "sun"], `${input()} free sections`);
      assert.equal(document.lockedSections.length, 7, `${input()} locked sections`);
      assert.equal(document.locale, locale);

      // 100% schema validity, re-validated independently of the pipeline
      for (const section of document.sections) {
        assert.equal(section.status, "generated", `${input()} ${section.key} generated`);
        const validation = validateSectionOutput(section.key, { blocks: section.blocks, closingQuestion: section.closingQuestion });
        assert.ok(validation.ok, `${input()} ${section.key}: ${validation.ok ? "" : validation.error}`);
        assert.ok(section.closingQuestion, `${input()} ${section.key} ends on the cliffhanger`);
        generatedSections += 1;
      }

      // every section of this (chart, locale) pair is a cache miss: exactly the
      // free sections are dispatched, no more, no fewer
      assert.equal(spyCalls.length, 2, `${input()} dispatched exactly the free sections`);
      // cost within the free ceiling, and latency recorded per section
      assert.ok(document.costMxn > 0 && document.costMxn <= TIER_CEILING_MXN.free, `${input()} cost ${document.costMxn} within free ceiling`);
      assert.equal(document.wastedCostMxn, 0, `${input()} nothing wasted on the happy path`);
      costByLocale[locale] += document.costMxn;
      assert.ok(document.sections.every(section => document.models[section.key] === "fixture-1"));

      function input() {
        return `${INPUTS[index].name}/${locale}`;
      }
    }
  }

  // per-section cost + latency recorded for every dispatch (12 docs × 2 sections)
  const rows = cache.snapshot();
  assert.equal(rows.length, INPUTS.length * LOCALES.length * 2);
  for (const row of rows) {
    assert.ok(row.value.usage.inputTokens > 0 && row.value.usage.outputTokens > 0, "usage recorded");
    assert.ok(row.value.latencyMs > 0, "latency recorded");
    assert.ok(row.value.costMxn > 0, "cost recorded");
    assert.ok(validateSectionOutput(row.key.section, row.value.output).ok, "cached output stays schema-valid");
  }

  // per-locale cost across the whole corpus (both locales pay for themselves)
  for (const locale of LOCALES) {
    assert.ok(costByLocale[locale] > 0 && costByLocale[locale] <= INPUTS.length * TIER_CEILING_MXN.free);
  }
  assert.ok(generatedSections >= INPUTS.length * LOCALES.length * 2);
});

test("corpus: paid tier for every chart — 9 sections, no locks, under the paid ceiling", async () => {
  const cache = new MemorySectionCache();
  for (const [index, input] of INPUTS.entries()) {
    const digest = chartDigest(calculateSolarReturnChart(input).facts);
    for (const locale of LOCALES) {
      const document = await generateReadingDocument({
        readingId: `corpus-paid-${index}-${locale}`,
        locale,
        tier: "paid",
        digest,
        cache,
        provider: createFixtureProvider(),
      });
      assert.equal(document.sections.length, 9, `${input.name}/${locale} paid sections`);
      assert.equal(document.lockedSections.length, 0);
      assert.ok(document.sections.every(section => section.status === "generated"));
      assert.ok(document.costMxn > 0 && document.costMxn <= TIER_CEILING_MXN.paid, `${input.name}/${locale} cost ${document.costMxn}`);
      assert.equal(document.wastedCostMxn, 0, `${input.name}/${locale} nothing wasted on the happy path`);
      for (const section of document.sections) {
        assert.ok(validateSectionOutput(section.key, { blocks: section.blocks, closingQuestion: section.closingQuestion }).ok);
      }
    }
  }
});

test("corpus: locales are separate cache rows and separate words (es ≠ en)", async () => {
  const cache = new MemorySectionCache();
  const digest = chartDigest(calculateSolarReturnChart(INPUTS[0]).facts);
  const documents: Record<Locale, Awaited<ReturnType<typeof generateReadingDocument>>> = { en: undefined as never, es: undefined as never };
  for (const locale of LOCALES) {
    documents[locale] = await generateReadingDocument({
      readingId: "corpus-locale-separation",
      locale,
      tier: "free",
      digest,
      cache,
      provider: createFixtureProvider(),
    });
  }
  // two dispatch sets, one per locale
  const keys = cache.snapshot().map(row => row.key);
  assert.equal(keys.filter(key => key.locale === "en").length, 2);
  assert.equal(keys.filter(key => key.locale === "es").length, 2);
  // the words differ: an es document must not be an en rerun
  const enOverview = JSON.stringify(documents.en.sections[0].blocks);
  const esOverview = JSON.stringify(documents.es.sections[0].blocks);
  assert.notEqual(enOverview, esOverview);
  // every es section still validates (proves the es rows, not en copies, were used)
  for (const section of documents.es.sections) {
    assert.ok(validateSectionOutput(section.key, { blocks: section.blocks, closingQuestion: section.closingQuestion }).ok);
  }
});

test("corpus: same digest and locale twice ⇒ frozen reuse, zero re-dispatch, zero cost", async () => {
  const cache = new MemorySectionCache();
  const digest = chartDigest(calculateSolarReturnChart(INPUTS[1]).facts);
  const first = await generateReadingDocument({
    readingId: "corpus-freeze-1",
    locale: "en",
    tier: "free",
    digest,
    cache,
    provider: createFixtureProvider(),
  });
  let calls = 0;
  const counting: ReadingProvider = {
    name: "counting",
    async complete(request) {
      calls += 1;
      return createFixtureProvider().complete(request);
    },
  };
  const second = await generateReadingDocument({
    readingId: "corpus-freeze-2",
    locale: "en",
    tier: "free",
    digest,
    cache,
    provider: counting,
  });
  assert.equal(calls, 0, "no re-dispatch on cache hit");
  assert.equal(second.costMxn, 0);
  assert.deepEqual(second.sections.map(section => section.blocks), first.sections.map(section => section.blocks));
});

test("corpus: forced provider failure degrades without throwing, chart always renders", async () => {
  const digest = chartDigest(calculateSolarReturnChart(INPUTS[2]).facts);
  for (const provider of [throwingProvider, garbageProvider]) {
    for (const tier of ["free", "paid"] as const) {
      const document = await generateReadingDocument({
        readingId: `corpus-failure-${provider.name}-${tier}`,
        locale: "es",
        tier,
        digest,
        cache: new MemorySectionCache(),
        provider,
      });
      const expectedSections = tier === "free" ? 2 : 9;
      assert.equal(document.sections.length, expectedSections);
      for (const section of document.sections) {
        assert.equal(section.status, "failed", `${provider.name}/${tier}/${section.key} failed, not fabricated`);
        assert.ok(section.blocks.length >= 1, "fallback blocks render");
        assert.ok(section.failureReason);
        assert.equal(section.closingQuestion, undefined);
      }
      assert.equal(document.costMxn, 0); // nothing was published
      // honest accounting: garbage responses reported usage, so their attempts
      // are recorded as waste; a throwing provider reports nothing
      if (provider === garbageProvider) assert.ok(document.wastedCostMxn > 0, `${provider.name}/${tier} wasted spend recorded`);
      else assert.equal(document.wastedCostMxn, 0, `${provider.name}/${tier} no spend invented for throws`);
      // the failure still produces a renderable document with locked copy
      assert.ok(document.contentVersion.length > 0);
    }
  }
});
