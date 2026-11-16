import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { users, readings, readingDocuments, readingGenerationRuns as runs, readingGenerationConsents as consents } from "../src/db/schema";
import { probeReadiness } from "../src/lib/readiness";
import { calculateSolarReturn } from "../src/lib/solar";
import type { ChartInput } from "../src/lib/types";
import type { ReadingDocument } from "../src/readings/types";

const gated = { skip: process.env.RUN_INTEGRATION_TESTS !== "1" ? "requires disposable local PostgreSQL" : false };

test("migration: current-schema upgrade, approved legacy adoption, idempotence, FK erasure and actual readiness drift", gated, async () => {
  const baseUrl = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1"].includes(baseUrl.hostname), "never rehearse against hosted data");
  const databaseName = `reading_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: baseUrl.toString(), max: 1 });
  const folder = await mkdtemp(path.join(os.tmpdir(), "solara-reading-upgrade-"));
  let upgraded: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    baseUrl.pathname = `/${databaseName}`;
    upgraded = new Pool({ connectionString: baseUrl.toString(), max: 2 });
    const database = drizzle(upgraded);
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const previous = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= 5) };
    await mkdir(path.join(folder, "meta"));
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
    for (const entry of previous.entries) await copyFile(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`));
    await migrate(database, { migrationsFolder: folder });

    const input: ChartInput = { name: "Synthetic legacy", birthDate: "1984-05-16", birthTime: "01:00", year: 2026, birthPlace: { name: "Mexicali", latitude: 32.6393, longitude: -115.4747, timezone: "America/Tijuana" }, returnPlace: { name: "New York", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" } };
    const result = calculateSolarReturn(input);
    async function create() {
      const [user] = await database.insert(users).values({ name: "Legacy fixture", email: `${randomUUID()}@example.invalid`, passwordHash: "not-a-real-hash" }).returning();
      const [chart] = await database.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
      return { user, chart };
    }
    async function document(readingId: string, model: string, locale: "en" | "es", createdAt: Date) {
      const id = randomUUID();
      const doc: ReadingDocument = {
        id, readingId, locale, tier: "free", generatedAt: createdAt.toISOString(), contentVersion: `legacy-${id}`, chartVersion: "chart/2", models: { overview: model },
        sections: [{ key: "overview", tier: "free", title: "Synthetic", blocks: [{ kind: "prose", text: "Synthetic legacy text" }], facts: {}, status: "generated" }], lockedSections: [], costMxn: 0, wastedCostMxn: 0,
      };
      await database.insert(readingDocuments).values({ id, readingId, locale, tier: "free", contentVersion: doc.contentVersion, chartVersion: doc.chartVersion, document: doc, createdAt });
      return id;
    }
    const real = await create(); const fixture = await create(); const chartOnly = await create(); const deleted = await create();
    const emptyModel = await create(); const malformedModel = await create(); const mixedCaseFixture = await create();
    const canonical = await document(real.chart.id, "legacy-real-model", "es", new Date("2026-01-01T00:00:00Z"));
    await document(real.chart.id, "legacy-real-model", "en", new Date("2026-01-02T00:00:00Z"));
    await document(fixture.chart.id, "fixture-1", "en", new Date("2026-01-01T00:00:00Z"));
    await document(emptyModel.chart.id, "", "en", new Date("2026-01-01T00:00:00Z"));
    const malformedId = await document(malformedModel.chart.id, "placeholder", "en", new Date("2026-01-01T00:00:00Z"));
    await upgraded.query("UPDATE reading_documents SET document=jsonb_set(document, '{models,overview}', '42'::jsonb) WHERE id=$1", [malformedId]);
    await document(mixedCaseFixture.chart.id, "Fixture-1", "en", new Date("2026-01-01T00:00:00Z"));
    await document(deleted.chart.id, "legacy-real-model", "en", new Date("2026-01-01T00:00:00Z"));
    await database.delete(readings).where(eq(readings.id, deleted.chart.id));

    await migrate(database, { migrationsFolder: "drizzle" });
    const adopted = await database.select().from(runs);
    assert.equal(adopted.length, 1); assert.equal(adopted[0].userId, real.user.id); assert.equal(adopted[0].documentId, canonical); assert.equal(adopted[0].locale, "es");
    assert.equal(adopted[0].status, "legacy"); assert.ok(adopted[0].consumedAt);
    assert.equal(adopted[0].settings, null, "no historical receipt or pricing snapshot invented");
    assert.equal((await database.select().from(consents)).length, 0, "migration never grants consent");
    for (const account of [fixture, chartOnly, deleted, emptyModel, malformedModel, mixedCaseFixture]) assert.equal(adopted.some(run => run.userId === account.user.id), false, "approved cutover exception");
    assert.equal((await database.select().from(readingDocuments)).length, 6, "legacy documents are preserved");

    await migrate(database, { migrationsFolder: "drizzle" });
    const safetySql = await readFile("drizzle/0006_reading_generation_safety.sql", "utf8");
    await upgraded.query(safetySql.split("--> statement-breakpoint").at(-1)!);
    assert.equal((await database.select().from(runs)).length, 1, "re-running migration/adoption cannot allocate another run");
    const ready = await probeReadiness(upgraded);
    assert.equal(ready.dbOk, true); assert.deepEqual(ready.missingTables, []); assert.deepEqual(ready.missingColumns, []); assert.deepEqual(ready.missingIndexes, []);
    await upgraded.query("ALTER TABLE reading_generation_consents DROP COLUMN receipt_id");
    assert.ok((await probeReadiness(upgraded)).missingColumns.includes("reading_generation_consents.receipt_id"), "the REAL readiness query introspects the new tables");
    await upgraded.query("ALTER TABLE reading_generation_consents ADD COLUMN receipt_id uuid NOT NULL DEFAULT gen_random_uuid()");
    await upgraded.query("DROP INDEX reading_runs_lifetime_user_key");
    assert.ok((await probeReadiness(upgraded)).missingIndexes.includes("reading_runs_lifetime_user_key"));
    await upgraded.query("CREATE UNIQUE INDEX reading_runs_lifetime_user_key ON reading_generation_runs(user_id) WHERE kind = 'lifetime_free'");

    await database.delete(readings).where(eq(readings.id, real.chart.id));
    const [tombstone] = await database.select().from(runs).where(eq(runs.userId, real.user.id));
    assert.equal(tombstone.readingId, null); assert.equal(tombstone.documentId, null); assert.ok(tombstone.consumedAt);
    await database.delete(users).where(eq(users.id, real.user.id));
    assert.equal((await database.select().from(runs)).length, 0);
  } finally {
    await upgraded?.end();
    // Pool.end sends termination, but the backend may still be closing. Normal
    // DROP waits for that cleanup; FORCE can race it and emit an idle-client error.
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  }
});
