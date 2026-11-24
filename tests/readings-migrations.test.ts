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

test("migration: current-schema upgrade, PR148 R7 legacy locales, idempotence, FK erasure and actual readiness drift", gated, async () => {
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
    const unsupported = [];
    const unsupportedDocuments: Array<{ id: string; locale: string }> = [];
    async function unsupportedDocument(readingId: string, locale: string) {
      const id = await document(readingId, "legacy-real-model", "en", new Date("2025-12-31T00:00:00Z"));
      // The legacy SQL column has no CHECK; seed historical data the TS enum cannot express.
      await upgraded!.query("UPDATE reading_documents SET locale=$2, document=jsonb_set(document, '{locale}', to_jsonb($2::text)) WHERE id=$1", [id, locale]);
      unsupportedDocuments.push({ id, locale });
    }
    for (const locale of ["fr", "es-MX", ""]) {
      const account = await create(); unsupported.push(account);
      await unsupportedDocument(account.chart.id, locale);
    }
    // An earlier invalid-locale document must not outrank the first valid canonical document.
    await unsupportedDocument(real.chart.id, "pt");
    const runbook = await readFile("docs/setup/09-reading-generation-safety.md", "utf8");
    const classificationSql = /```sql\n(WITH evidence AS [\s\S]*?)\n```/.exec(runbook)?.[1];
    assert.ok(classificationSql, "execute the published pre-migration aggregate, not a copied predicate");
    const classification = await upgraded.query(classificationSql);

    await assert.doesNotReject(() => migrate(database, { migrationsFolder: "drizzle" }), "unsupported legacy locales must not abort the upgrade");
    assert.deepEqual(Object.fromEntries(Object.entries(classification.rows[0]).map(([key, value]) => [key, Number(value)])), {
      surviving_free_documents: 10, qualifying_documents: 2, fixture_or_mixed_documents: 2,
      ambiguous_documents: 6, qualifying_accounts: 1, accounts_without_qualifying_evidence: 9,
    }, "operator classification and actual adoption must agree");
    const adopted = await database.select().from(runs);
    assert.equal(adopted.length, 1); assert.equal(adopted[0].userId, real.user.id); assert.equal(adopted[0].documentId, canonical); assert.equal(adopted[0].locale, "es");
    assert.equal(adopted[0].status, "legacy"); assert.ok(adopted[0].consumedAt);
    assert.equal(adopted[0].settings, null, "no historical receipt or pricing snapshot invented");
    assert.equal((await database.select().from(consents)).length, 0, "migration never grants consent");
    // Independent SQL catalog/data assertions, not the runtime manifest's own
    // expected arrays. The additive paid migrations must not adopt legacy prose
    // or preapprove/enable a processor while upgrading the free cutover.
    for (const table of ["paid_reading_allowances", "paid_reading_approvals", "paid_reading_attempts", "paid_reading_checkpoints", "paid_reading_editions", "paid_reading_runs", "paid_reading_snapshots"]) {
      assert.equal((await upgraded.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0, table);
    }
    assert.deepEqual((await upgraded.query("SELECT id, enabled, revision, worker_heartbeat_at, worker_config_hash FROM paid_reading_control")).rows,
      [{ id: "paid", enabled: false, revision: 0, worker_heartbeat_at: null, worker_config_hash: null }]);
    const triggers = await upgraded.query("SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('paid_reading_editions'::regclass, 'paid_reading_snapshots'::regclass) ORDER BY tgname");
    assert.deepEqual(triggers.rows, [{ tgname: "paid_editions_immutable", tgenabled: "O" }, { tgname: "paid_snapshots_immutable", tgenabled: "O" }]);
    const paidConstraints = await upgraded.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'paid_reading_runs'::regclass");
    const definition = (name: string) => paidConstraints.rows.find(row => row.conname === name)?.definition ?? "";
    assert.match(definition("paid_runs_manifest_check"), /paid-core-v1[\s\S]*paid-rich-v1/);
    assert.match(definition("paid_runs_manifest_check"), /planetaryYear[\s\S]*transits/);
    assert.match(definition("paid_runs_state_check"), /jsonb_array_length/);
    assert.match(definition("paid_reading_runs_reading_id_readings_id_fk"), /ON DELETE SET NULL/);
    assert.match(definition("paid_reading_runs_user_id_users_id_fk"), /ON DELETE CASCADE/);
    const indexes = await upgraded.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('paid_reading_runs','paid_reading_attempts')");
    for (const name of ["paid_runs_intent_key", "paid_runs_active_user_key", "paid_attempts_slot_key", "paid_attempts_outstanding_key"]) {
      assert.match(indexes.rows.find(row => row.indexname === name)?.indexdef ?? "", /CREATE UNIQUE INDEX/, name);
    }
    assert.match(indexes.rows.find(row => row.indexname === "paid_attempts_outstanding_key")?.indexdef ?? "", /WHERE.*reserved/);
    for (const account of [fixture, chartOnly, deleted, emptyModel, malformedModel, mixedCaseFixture, ...unsupported]) assert.equal(adopted.some(run => run.userId === account.user.id), false, "approved cutover exception");
    const preserved = await database.select().from(readingDocuments);
    assert.equal(preserved.length, 10, "legacy documents are preserved");
    for (const invalid of unsupportedDocuments) assert.equal(preserved.find(doc => doc.id === invalid.id)?.locale, invalid.locale, "unsupported locales are left unchanged for classification");

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
