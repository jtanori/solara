import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { users, readings, readingDocuments, readingGenerationRuns as runs, readingGenerationConsents as consents, readingGenerationAttempts as attempts, rateLimits,
  paidReadingRuns as paidRuns, paidReadingAttempts as paidAttempts, paidReadingAllowances as paidAllowances,
  paidReadingEditions as paidEditions, paidReadingSnapshots as paidSnapshots, paidReadingCheckpoints as paidCheckpoints } from "../../src/db/schema";
import { keyFor } from "../../src/lib/rate-limit";
import { calculateSolarReturn } from "../../src/lib/solar";
import type { ReadingViewer } from "../../src/readings/reading-view";
import { frozenReading, readingChartInput } from "./reading-fixtures";

export async function syntheticReadingAccount(locale: "en" | "es" = "en", edition: Parameters<typeof frozenReading>[1] | "none" = "free") {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname), "synthetic account helper requires a disposable loopback database");
  const verified = new Date("2026-01-01T00:00:00.000Z");
  const [user] = await db.insert(users).values({ name: "Synthetic reading QA", email: `${randomUUID()}@example.com`, passwordHash: "unused-fixture-hash", emailVerifiedAt: verified }).returning({ id: users.id });
  const [chart] = await db.insert(readings).values({ userId: user.id, year: 2026, input: readingChartInput, result: calculateSolarReturn(readingChartInput) }).returning();
  const document = { ...frozenReading(locale, edition === "none" ? "free" : edition), id: randomUUID(), readingId: chart.id };
  const viewer: ReadingViewer = { id: user.id, emailVerifiedAt: verified, plan: "free" };
  async function publish() {
    await db.insert(readingDocuments).values({ id: document.id, readingId: chart.id, locale, contentVersion: document.contentVersion, chartVersion: document.chartVersion, tier: document.tier, document });
    await db.insert(runs).values({ userId: user.id, readingId: chart.id, documentId: document.id, locale, status: edition?.startsWith("partial") ? "partial" : "completed", consumedAt: verified, contentVersion: document.contentVersion });
  }
  if (edition !== "none") await publish();
  return { viewer, chart, document, publish, cleanup: async () => {
    await db.delete(rateLimits).where(inArray(rateLimits.key, ["pdf", "status", "consent", "delete", "generate"].map(action => keyFor(`readings:${action}:user`, user.id))));
    await db.delete(users).where(eq(users.id, user.id));
  } };
}
export async function readingLedgerSnapshot(userId: string) {
  const charts = await db.select({ id: readings.id }).from(readings).where(eq(readings.userId, userId));
  const run = await db.select().from(runs).where(eq(runs.userId, userId));
  const paid = await db.select().from(paidRuns).where(eq(paidRuns.userId, userId));
  const paidIds = paid.map(row => row.id);
  return JSON.stringify({ run, paid,
    paidAllowances: await db.select().from(paidAllowances).where(eq(paidAllowances.userId, userId)),
    paidAttempts: paidIds.length ? await db.select().from(paidAttempts).where(inArray(paidAttempts.runId, paidIds)) : [],
    paidEditions: paidIds.length ? await db.select().from(paidEditions).where(inArray(paidEditions.runId, paidIds)) : [],
    paidSnapshots: paidIds.length ? await db.select().from(paidSnapshots).where(inArray(paidSnapshots.runId, paidIds)) : [],
    paidCheckpoints: paidIds.length ? await db.select().from(paidCheckpoints).where(inArray(paidCheckpoints.runId, paidIds)) : [],
    documents: charts.length ? await db.select().from(readingDocuments).where(inArray(readingDocuments.readingId, charts.map(c => c.id))) : [],
    consent: await db.select().from(consents).where(eq(consents.userId, userId)),
    attempts: run.length ? await db.select().from(attempts).where(inArray(attempts.runId, run.map(r => r.id))) : [],
  });
}
