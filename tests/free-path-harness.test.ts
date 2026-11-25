import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import type { Locale } from "../src/lib/i18n";

/*
 * #226: the free-reading journey on a disposable database. These tests run the real handlers and
 * the real persistence; only the provider is injected. Gated like the other database suites.
 */

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: !enabled ? "requires RUN_INTEGRATION_TESTS=1 and disposable local PostgreSQL" : false };

after(async () => {
  if (!enabled) return;
  const { pool, coordinationPool } = await import("../src/db");
  await Promise.all([pool.end(), coordinationPool.end()]);
});

test("the corpus exposes the six named cases", async () => {
  const { loadChartCorpus } = await import("../scripts/lib/chart-corpus");
  assert.deepEqual(
    loadChartCorpus().map(entry => entry.id),
    ["baseline", "fold-earlier", "fold-later", "southern", "leap-day", "polar-natal"],
  );
});

test("all six cases produce a completed free document with overview and sun", gated, async () => {
  const { runFreePathJourney, fixtureConfig, fixtureFetch } = await import("../scripts/lib/free-path");
  const { loadChartCorpus } = await import("../scripts/lib/chart-corpus");

  const report = await runFreePathJourney({
    corpus: loadChartCorpus(),
    locales: ["es"],
    configFor: () => fixtureConfig(fixtureFetch()),
    mode: "fixture",
  });

  assert.equal(report.cases.length, 6);
  assert.equal(report.summary.documents, 6);
  assert.equal(report.summary.completed, 6);
  assert.equal(report.summary.failed, 0);
  for (const entry of report.cases) {
    assert.equal(entry.status, "completed", entry.id);
    assert.deepEqual(entry.sections.map(section => section.key), ["overview", "sun"], entry.id);
    assert.ok(entry.sections.every(section => section.status === "generated"), entry.id);
    assert.match(entry.contentVersion ?? "", /^[a-f0-9]+$/, entry.id);
    assert.ok((entry.chartVersion ?? "").length > 0, entry.id);
    assert.match(entry.documentHash ?? "", /^[a-f0-9]+$/, entry.id);
  }
  assert.equal(report.summary.runsPerUser, 1, "one lifetime offer per account");
  assert.equal(report.summary.secondGenerationSameDocument, true, "a second generation reuses the document");
});

test("the harness deletes its synthetic accounts unless asked to keep them", gated, async () => {
  const { runFreePathJourney, fixtureConfig, fixtureFetch, readingExists } = await import("../scripts/lib/free-path");
  const { loadChartCorpus } = await import("../scripts/lib/chart-corpus");

  const report = await runFreePathJourney({
    corpus: [loadChartCorpus()[0]],
    locales: ["es"],
    configFor: () => fixtureConfig(fixtureFetch()),
    mode: "fixture",
  });

  assert.equal(await readingExists(report.cases[0].readingId), false);
});

test("a failed generation keeps the lifetime offer consumed and creates no second run", gated, async () => {
  const { runFreePathJourney, fixtureConfig } = await import("../scripts/lib/free-path");
  const { loadChartCorpus } = await import("../scripts/lib/chart-corpus");
  const { handleGeneration } = await import("../src/readings/http");
  const { GenerationStore } = await import("../src/readings/generation-store");
  const { db } = await import("../src/db");
  const { users, readingGenerationRuns: runs } = await import("../src/db/schema");

  const { failingFetch } = await import("../scripts/lib/free-path");
  const configFor = () => fixtureConfig(failingFetch());
  const [entry] = loadChartCorpus().filter(row => row.id === "polar-natal");

  const report = await runFreePathJourney({
    corpus: [entry],
    locales: ["es"],
    configFor,
    mode: "fixture",
    keep: true,
  });

  const failed = report.cases[0];
  const [run] = await db.select().from(runs).where(eq(runs.readingId, failed.readingId));
  try {
    assert.ok(run, "the run exists");
    assert.notEqual(failed.status, "completed");
    assert.ok(["failed", "partial", "indeterminate"].includes(failed.status), failed.status);
    assert.ok(run.consumedAt, "the offer was consumed by the failed run");

    const [user] = await db.select().from(users).where(eq(users.id, run.userId));
    assert.ok(user);
    const deps = {
      user: async () => user,
      locale: "es" as const,
      throttle: async () => null,
      store: new GenerationStore(),
      config: configFor,
      enabled: () => true,
      locales: () => new Set<Locale>(["es"]),
    };
    const again = await handleGeneration(
      new Request("http://localhost/api/readings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: "es" }),
      }),
      failed.readingId,
      deps,
    );
    const view = (await again.json()) as { status: string; documentId: string | null };
    assert.equal(view.status, failed.status, "a retry returns the stored result, not a new run");

    const afterRows = await db.select().from(runs).where(eq(runs.userId, run.userId));
    assert.equal(afterRows.length, 1, "no second run was created");
  } finally {
    if (run) await db.delete(users).where(eq(users.id, run.userId));
  }
});

test("the harness never enables generation or paid flags", gated, async () => {
  const { runFreePathJourney, fixtureConfig, fixtureFetch } = await import("../scripts/lib/free-path");
  const { loadChartCorpus } = await import("../scripts/lib/chart-corpus");
  const savedFree = process.env.READINGS_GENERATION_ENABLED;
  const savedPaid = process.env.READINGS_PAID_GENERATION_ENABLED;
  delete process.env.READINGS_GENERATION_ENABLED;
  delete process.env.READINGS_PAID_GENERATION_ENABLED;
  try {
    await runFreePathJourney({
      corpus: [loadChartCorpus()[0]],
      locales: ["es"],
      configFor: () => fixtureConfig(fixtureFetch()),
      mode: "fixture",
    });
    assert.equal(process.env.READINGS_GENERATION_ENABLED, undefined);
    assert.equal(process.env.READINGS_PAID_GENERATION_ENABLED, undefined);
  } finally {
    if (savedFree !== undefined) process.env.READINGS_GENERATION_ENABLED = savedFree;
    if (savedPaid !== undefined) process.env.READINGS_PAID_GENERATION_ENABLED = savedPaid;
  }
});
