import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { coordinationPool, db, pool } from "../src/db";
import {
  paidReadingAllowances,
  paidReadingEditions,
  paidReadingRuns,
  readingDocuments,
  readingGenerationRuns,
  readings,
  users,
} from "../src/db/schema";
import type { ReadingViewer } from "../src/readings/reading-view";
import { loadReadingPresentation } from "../src/readings/reading-view";
import { PAID_PROFILE, paidSections } from "../src/readings/paid-contract";
import { syntheticPaidEvaluation } from "./helpers/paid-evaluation";
import { loadChartCorpus } from "../scripts/lib/chart-corpus";

/*
 * #225 / A2b: the seed is the fixture the next phase reuses, so it has to be re-runnable and it
 * has to leave the ledger in a state the product can actually produce. The first version collided
 * with the free-document key, the one-lifetime-free-run index and wrote a consumed paid run with no
 * allowance row; this test drives the real CLI twice to prove none of that is still true.
 */

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: enabled ? false : "requires RUN_INTEGRATION_TESTS=1 and disposable local PostgreSQL" };
const TSX = path.resolve("node_modules/.bin/tsx");
const CLI = path.resolve("scripts/pilot-seed.ts");
const OUT = ".venv/pilot-seed-test";

after(async () => {
  rmSync(OUT, { recursive: true, force: true });
  if (enabled) await Promise.all([pool.end(), coordinationPool.end()]);
});

type Fixture = { reportPath: string; caseA: string; caseB: string; report: Awaited<ReturnType<typeof syntheticPaidEvaluation>> };

let cached: Promise<Fixture> | null = null;
/** Built once per file: the synthetic report is the expensive part of both cases. */
function fixture(): Promise<Fixture> {
  cached ??= writeReport();
  return cached;
}

async function writeReport(): Promise<Fixture> {
  const caseIds = loadChartCorpus().map(entry => entry.id).slice(0, 2);
  const report = await syntheticPaidEvaluation(PAID_PROFILE, caseIds);
  const generated = report.samples.filter(sample => sample.sections.length > 0 && sample.sections.every(section => section.status === "generated"));
  const caseA = generated[0]?.caseId;
  const caseB = generated.find(sample => sample.caseId !== caseA)?.caseId;
  assert.ok(caseA && caseB, "the synthetic report has two complete cases");
  const samples = report.samples.filter(sample => sample.caseId === caseA || sample.caseId === caseB);
  mkdirSync(OUT, { recursive: true });
  const reportPath = path.join(OUT, "report.json");
  writeFileSync(reportPath, JSON.stringify({ ...report, samples }, null, 2));
  return { reportPath, caseA, caseB, report };
}

async function makeUser(): Promise<{ id: string; email: string; viewer: ReadingViewer }> {
  const email = `pilot-seed-${randomUUID()}@example.com`;
  const verified = new Date("2026-01-01T00:00:00.000Z");
  const [user] = await db.insert(users)
    .values({ name: "Pilot seed QA", email, passwordHash: "unused-fixture-hash", emailVerifiedAt: verified })
    .returning({ id: users.id });
  return { id: user.id, email, viewer: { id: user.id, emailVerifiedAt: verified, plan: "free" } };
}

function seed(fixture: Fixture, email: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI, "--report", fixture.reportPath, "--email", email, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the seed is re-runnable and leaves one ledger-consistent fixture", gated, async () => {
  const data = await fixture();
  const user = await makeUser();
  try {
    const first = seed(data, user.email, ["--mode", "both", "--case", data.caseA, "--period", "2026-01"]);
    assert.equal(first.status, 0, first.stderr);
    const second = seed(data, user.email, ["--mode", "both", "--case", data.caseA, "--period", "2026-01"]);
    assert.equal(second.status, 0, `second run must not collide: ${second.stderr}`);

    const readingId = (JSON.parse(first.stdout) as { readingId: string }).readingId;
    const ownedDocuments = await db.select().from(readingDocuments)
      .where(and(eq(readingDocuments.readingId, readingId), eq(readingDocuments.tier, "free")));
    assert.equal(ownedDocuments.length, 1, "one free document, updated in place");

    const runs = await db.select().from(readingGenerationRuns).where(eq(readingGenerationRuns.userId, user.id));
    assert.equal(runs.length, 1, "the lifetime-free offer stays a single row");
    assert.equal(runs[0].documentId, ownedDocuments[0].id, "the run points at the seeded document");
    assert.ok(runs[0].consumedAt, "the offer is represented as consumed");

    const paid = await db.select().from(paidReadingRuns).where(and(eq(paidReadingRuns.userId, user.id), eq(paidReadingRuns.period, "2026-01")));
    assert.equal(paid.length, 1, "re-running replaces the fixture run instead of duplicating it");
    const editions = await db.select().from(paidReadingEditions).where(eq(paidReadingEditions.runId, paid[0].id));
    assert.equal(editions.length, 1);

    const allowances = await db.select().from(paidReadingAllowances).where(and(eq(paidReadingAllowances.userId, user.id), eq(paidReadingAllowances.period, "2026-01")));
    assert.equal(allowances.length, 1, "a consumed run has its allowance row");
    assert.equal(allowances[0].runId, paid[0].id);
    assert.ok(allowances[0].consumedAt, "the month is represented as consumed");

    const free = await loadReadingPresentation(user.viewer, readingId, "es");
    assert.equal(free.availability, "ready", "the seeded free document is readable");
    assert.equal(free.content.kind, "saved-reading");

    const paidView = await loadReadingPresentation(user.viewer, readingId, "es", { kind: "paid", id: editions[0].id });
    assert.equal(paidView.content.kind, "saved-reading", "the seeded paid edition is readable");
    assert.equal(paidView.content.partial, false);

    const again = JSON.parse(second.stdout) as { free: { reused: boolean; documentId: string }; paid: { runId: string } };
    assert.equal(again.free.reused, true, "the second run reuses the lifetime-free row");
    assert.equal(again.free.documentId, ownedDocuments[0].id);
    assert.equal(again.paid.runId, paid[0].id, "the second run replaces, not appends");
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("the free offer is never repointed to another reading without --replace-free", gated, async () => {
  const data = await fixture();
  const user = await makeUser();
  try {
    const first = seed(data, user.email, ["--mode", "free", "--case", data.caseA]);
    assert.equal(first.status, 0, first.stderr);

    const moved = seed(data, user.email, ["--mode", "free", "--case", data.caseB]);
    assert.equal(moved.status, 1, "a second chart must not silently take over the free offer");
    assert.match(moved.stderr, /free offer already points at reading/);
    assert.match(moved.stderr, /--replace-free/);

    const replaced = seed(data, user.email, ["--mode", "free", "--case", data.caseB, "--replace-free"]);
    assert.equal(replaced.status, 0, replaced.stderr);
    const runs = await db.select().from(readingGenerationRuns).where(eq(readingGenerationRuns.userId, user.id));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].readingId, JSON.parse(replaced.stdout).readingId);
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("a report with no generated section is refused instead of seeded", gated, async () => {
  const data = await fixture();
  const allFailed = {
    ...data.report,
    samples: data.report.samples
      .filter(sample => sample.caseId === data.caseA)
      .map(sample => ({
        ...sample,
        sections: sample.sections.map(section => ({ ...section, status: "failed" as const, blocks: [] })),
      })),
  };
  const reportPath = path.join(OUT, "all-failed.json");
  writeFileSync(reportPath, JSON.stringify(allFailed));
  const user = await makeUser();
  try {
    // The five 0/N pilots are on disk and --report is operator-supplied, so this is a reachable
    // input. It used to write a document with nothing generated while the run said "completed".
    const free = seed({ ...data, reportPath }, user.email, ["--mode", "both", "--case", data.caseA]);
    assert.equal(free.status, 1, "a free fixture the page cannot render is not written");
    assert.match(free.stderr, /has no generated free section/);

    const paid = seed({ ...data, reportPath }, user.email, ["--mode", "paid", "--case", data.caseA]);
    assert.equal(paid.status, 1, "a paid edition the page cannot render is not written");
    assert.match(paid.stderr, /has no generated section/);

    // One transaction per mode: the refusal left nothing behind, not even the chart row.
    const charts = await db.select({ id: readings.id }).from(readings).where(eq(readings.userId, user.id));
    assert.equal(charts.length, 0);
    const paidRuns = await db.select({ id: paidReadingRuns.id }).from(paidReadingRuns).where(eq(paidReadingRuns.userId, user.id));
    assert.equal(paidRuns.length, 0);
    const allowances = await db.select({ runId: paidReadingAllowances.runId }).from(paidReadingAllowances).where(eq(paidReadingAllowances.userId, user.id));
    assert.equal(allowances.length, 0, "the month was not consumed");
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("the seed writes the genuine partial shape, not only complete editions", gated, async () => {
  const data = await fixture();
  const failedKey = paidSections(data.report.profile).at(-1)!;
  const partial = {
    ...data.report,
    samples: data.report.samples
      .filter(sample => sample.caseId === data.caseA && sample.locale === "en")
      .map(sample => ({
        ...sample,
        sections: sample.sections.map(section => section.key === failedKey
          ? { ...section, status: "failed" as const, blocks: [] }
          : section),
      })),
  };
  const reportPath = path.join(OUT, "partial.json");
  writeFileSync(reportPath, JSON.stringify(partial));
  const user = await makeUser();
  try {
    // rich-es-go2 (10/11, guidance failed) is the only genuine partial pilot and the shape the
    // next phase renders; the complete cases alone never exercise status "partial".
    const result = seed({ ...data, reportPath }, user.email, ["--mode", "paid", "--case", data.caseA, "--period", "2026-01"]);
    assert.equal(result.status, 0, result.stderr);
    const readingId = (JSON.parse(result.stdout) as { readingId: string }).readingId;

    const [run] = await db.select().from(paidReadingRuns)
      .where(and(eq(paidReadingRuns.userId, user.id), eq(paidReadingRuns.period, "2026-01")));
    assert.equal(run.status, "partial", "a report with a failed section is not recorded as completed");
    assert.equal(run.completedSections, paidSections(data.report.profile).length - 1);
    assert.ok(run.consumedAt, "the edition exists, so the month is consumed");

    const [edition] = await db.select().from(paidReadingEditions).where(eq(paidReadingEditions.runId, run.id));
    const view = await loadReadingPresentation(user.viewer, readingId, "en", { kind: "paid", id: edition.id });
    assert.equal(view.content.kind, "saved-reading");
    if (view.content.kind !== "saved-reading") return;
    assert.equal(view.content.partial, true);
    assert.ok(view.content.notices.includes("partial"));
    const failed = view.content.sections.find(section => section.key === failedKey);
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.notices.includes("section_failed"), "the failed section carries its notice");
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});
