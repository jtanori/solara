import "dotenv/config";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { readings, readingDocuments, users } from "../src/db/schema";
import { calculateSolarReturnChart } from "../src/lib/solar";
import { chartDigest } from "../src/lib/chart";
import { createFixtureProvider } from "../src/readings/provider";
import { DbSectionCache } from "../src/readings/db-cache";
import { computeContentVersion } from "../src/readings/content-version";
import { generateReadingDocument, digestHashOf } from "../src/readings/generate";
import { persistableDocument } from "../src/readings/document";
import type { ChartInput } from "../src/lib/types";
import type { Locale } from "../src/lib/i18n";

/**
 * Live-database tests for the #103 persistence layer (CI runs these with a
 * real Postgres; locally they are the known DATABASE_URL-required class).
 * Covers what the memory cache cannot: the insert-only freeze at the database
 * level and the reading_documents unique slot.
 */

const input: ChartInput = {
  name: "Db Integration",
  birthDate: "1984-05-16",
  birthTime: "01:00",
  birthPlace: { name: "Mexicali, Mexico", latitude: 32.6393, longitude: -115.4747, timezone: "America/Tijuana" },
  returnPlace: { name: "New York, United States", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" },
  year: 2026,
};

const digest = chartDigest(calculateSolarReturnChart(input).facts);

before(() => {
  process.env.READINGS_GENERATION_ENABLED = "true";
});
after(() => {
  delete process.env.READINGS_GENERATION_ENABLED;
});

test("DbSectionCache: roundtrip, key dimensions, and insert-only freeze against a live database", async () => {
  const cache = new DbSectionCache();
  const key = {
    digestHash: `test-${digestHashOf(digest)}`,
    section: "overview" as const,
    locale: "en" as Locale,
    contentVersion: `test-${computeContentVersion()}`,
  };
  const value = {
    output: { blocks: [{ kind: "prose" as const, text: "db integration" }] },
    model: "fixture-1",
    usage: { inputTokens: 10, outputTokens: 10 },
    costMxn: 0.001,
    latencyMs: 3,
  };
  await cache.put(key, value);
  const readBack = await cache.get(key);
  assert.ok(readBack, "roundtrip");
  assert.equal(readBack.model, "fixture-1");
  assert.equal(readBack.costMxn, 0.001);
  // freeze: a second put on the same key does not overwrite the frozen row
  await cache.put(key, { ...value, model: "other-model" });
  const still = await cache.get(key);
  assert.equal(still?.model, "fixture-1", "insert-only: first write wins at the database level");
  // key dimensions: a different locale misses
  assert.equal(await cache.get({ ...key, locale: "es" }), null, "locale is a cache-key dimension in the DB");
});

test("reading_documents: the (reading, locale, contentVersion) slot keeps its first document", async () => {
  const [user] = await db
    .insert(users)
    .values({ name: "Db Reading Docs", email: `dbdocs-${Date.now()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  const { result } = calculateSolarReturnChart(input);
  const [reading] = await db
    .insert(readings)
    .values({ userId: user.id, year: input.year, input, result })
    .returning({ id: readings.id });

  const document = await generateReadingDocument({
    readingId: reading.id,
    locale: "en",
    tier: "free",
    digest,
    cache: new DbSectionCache(),
    provider: createFixtureProvider(),
  });
  assert.ok(persistableDocument(document), "the fixture document is persistable");

  await db.insert(readingDocuments).values({
    id: document.id,
    readingId: reading.id,
    locale: "en",
    contentVersion: document.contentVersion,
    chartVersion: document.chartVersion,
    tier: document.tier,
    document,
  }).onConflictDoNothing();

  // A second, different document competing for the same slot is refused.
  const rival = { ...document, id: randomUUID(), generatedAt: new Date().toISOString() };
  await db.insert(readingDocuments).values({
    id: rival.id,
    readingId: reading.id,
    locale: "en",
    contentVersion: rival.contentVersion,
    chartVersion: rival.chartVersion,
    tier: rival.tier,
    document: rival,
  }).onConflictDoNothing();

  const rows = await db
    .select({ id: readingDocuments.id })
    .from(readingDocuments)
    .where(eq(readingDocuments.readingId, reading.id));
  assert.equal(rows.length, 1, "exactly one row occupies the slot");
  assert.equal(rows[0].id, document.id, "the first document wins");

  // cascade cleanup
  await db.delete(users).where(eq(users.id, user.id));
  const remaining = await db
    .select({ id: readingDocuments.id })
    .from(readingDocuments)
    .where(eq(readingDocuments.readingId, reading.id));
  assert.equal(remaining.length, 0, "reading documents cascade with their reading");
});
