#!/usr/bin/env tsx
// pilot-seed.ts — import a pilot report into the local disposable database (#225).
//
// The next end-to-end phase (onboarding → payments → account) should not need a provider call.
// This writes the report's sections as a saved free document and/or a pinned paid edition for a
// seeded user, so the reading/PDF pages have genuine content locally. Nothing is committed.
//
// Idempotent by design: re-running replaces the fixture it previously wrote instead of colliding
// with the free-document key, the one-lifetime-free-run index, or the month allowance. A free seed
// genuinely consumes the account's lifetime free offer (that is the state it represents), so use a
// separate account for free-generation tests.
//
// Usage: npx tsx scripts/pilot-seed.ts --report <report.json> --email <seeded@user> [--case <id>]
//                                      [--mode paid|free|both] [--period 2026-01] [--replace-free]
//
// Prereq: DATABASE_URL is loopback and the user exists (`npm run db:seed:local`).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { coordinationPool, db, pool } from "../src/db";
import {
  paidReadingAllowances,
  paidReadingEditions,
  paidReadingRuns,
  readingChartFacts,
  readingDocuments,
  readingGenerationRuns,
  readings,
  users,
} from "../src/db/schema";
import { chartDigest } from "../src/lib/chart";
import { calculateSolarReturn, calculateSolarReturnChart, solarReturnFacts } from "../src/lib/solar";
import { baseFactsRow } from "../src/readings/chart-facts";
import { canonicalHash } from "../src/readings/policy";
import { buildReadingDocument, persistableDocument } from "../src/readings/document";
import { paidEvaluationSchema } from "../src/readings/evaluation";
import { calculatePaidSnapshot, paidDigest, paidSnapshotHash } from "../src/readings/paid-chart";
import { PAID_ALLOWANCE_POLICY, paidSections, type PaidProfile } from "../src/readings/paid-contract";
import { fixtureGuard } from "./lib/free-path-guard";
import { loadChartCorpus } from "./lib/chart-corpus";
import { reportSectionResults } from "./lib/pilot-render";
import { describeSeedError, SeedError } from "./lib/seed-error";

/** Fixture provenance: lets a re-run find and replace exactly what a previous run wrote. */
const SEED_ENTITLEMENT = "sub_pilot_seed";
const FREE_CONTENT_VERSION = "pilot-seed/1";

function fail(message: string, code = 1): never {
  console.error(`ERROR ${message}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const value = (flag: string): string => {
  const index = argv.indexOf(flag);
  return index === -1 ? "" : (argv[index + 1] ?? "");
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: pilot-seed --report <report.json> --email <user@example.test> [--case <id>] [--mode paid|free|both] [--period 2026-01] [--replace-free]");
  process.exit(0);
}

const reportPath = value("--report").trim();
const email = value("--email").trim().toLowerCase();
const caseId = value("--case").trim();
const mode = (value("--mode").trim() || "paid") as "paid" | "free" | "both";
const period = value("--period").trim() || "2026-01";
const replaceFree = argv.includes("--replace-free");
if (!reportPath || !email) fail("--report and --email are required", 2);
if (!["paid", "free", "both"].includes(mode)) fail("--mode must be paid, free or both", 2);
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail("--period must be YYYY-MM", 2);

const guard = fixtureGuard(process.env);
if (!guard.ok) fail(`refused: ${guard.reason}`, 2);

type SeedOutput = {
  readingId: string;
  free?: { documentId: string; runId: string; reused: boolean };
  paid?: { runId: string; editionId: string; period: string; allowance: "consumed" };
};

async function seed(): Promise<SeedOutput> {
  const report = paidEvaluationSchema.parse(JSON.parse(readFileSync(reportPath, "utf8")) as unknown);
  const sample = (caseId ? report.samples.find(row => row.caseId === caseId) : report.samples[0]);
  if (!sample) throw new SeedError(`report has no case ${caseId || "(empty)"}`);
  const corpus = loadChartCorpus().find(entry => entry.id === sample.caseId);
  if (!corpus) throw new SeedError(`corpus has no case ${sample.caseId}`);

  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new SeedError(`user ${email} does not exist; run npm run db:seed:local first`);

  const result = calculateSolarReturn(corpus.input);
  const results = reportSectionResults(report, sample);

  return db.transaction(async tx => {
    // Identity is the chart input, not its display name: every corpus case is called
    // "Synthetic Annual Facts", so a name match would collapse six distinct charts into one.
    const inputKey = canonicalHash(corpus.input);
    const owned = await tx.select({ id: readings.id, input: readings.input }).from(readings).where(eq(readings.userId, user.id));
    const found = owned.find(row => canonicalHash(row.input) === inputKey);
    let readingId: string;
    if (found) {
      readingId = found.id;
      const [facts] = await tx.select({ readingId: readingChartFacts.readingId }).from(readingChartFacts)
        .where(eq(readingChartFacts.readingId, readingId)).limit(1);
      if (!facts) {
        const row = baseFactsRow(solarReturnFacts, corpus.input, result);
        if ("row" in row) await tx.insert(readingChartFacts).values({ readingId, ...row.row });
      }
    } else {
      const [saved] = await tx.insert(readings)
        .values({ userId: user.id, year: corpus.input.year ?? 2026, input: corpus.input, result }).returning({ id: readings.id });
      readingId = saved.id;
      const row = baseFactsRow(solarReturnFacts, corpus.input, result);
      if ("row" in row) await tx.insert(readingChartFacts).values({ readingId, ...row.row });
    }

    const output: SeedOutput = { readingId };
    const now = new Date();

    if (mode === "free" || mode === "both") {
      const freeResults = results.filter(entry => entry.key === "overview" || entry.key === "sun");
      const document = buildReadingDocument({
        readingId,
        locale: sample.locale,
        tier: "free",
        digest: chartDigest(calculateSolarReturnChart(corpus.input).facts),
        contentVersion: FREE_CONTENT_VERSION,
        results: freeResults,
      });
      // A 0/N pilot (nine failed sections) would write a document with nothing generated: the
      // page reports `document_unavailable` while the run below says "completed". Refuse instead.
      if (!persistableDocument(document)) {
        throw new SeedError(`report ${sample.caseId}/${sample.locale} has no generated free section; refusing to write a document the page cannot render`);
      }
      // The key is (readingId, locale, contentVersion): update the previous seed in place rather
      // than inserting a second document that the unique index would reject. The row id is the
      // identity `readStoredDocument` checks against the JSON, so a rebuild keeps the existing id.
      const [existingDocument] = await tx.select({ id: readingDocuments.id }).from(readingDocuments)
        .where(and(
          eq(readingDocuments.readingId, readingId),
          eq(readingDocuments.locale, sample.locale),
          eq(readingDocuments.contentVersion, FREE_CONTENT_VERSION),
        )).for("update");
      let documentId: string;
      if (existingDocument) {
        documentId = existingDocument.id;
        await tx.update(readingDocuments)
          .set({ document: { ...document, id: documentId }, chartVersion: document.chartVersion })
          .where(eq(readingDocuments.id, documentId));
      } else {
        documentId = document.id;
        await tx.insert(readingDocuments).values({
          id: documentId, readingId, locale: sample.locale, contentVersion: FREE_CONTENT_VERSION,
          chartVersion: document.chartVersion, tier: "free", document,
        });
      }

      // One lifetime-free run per account, enforced by a partial unique index. Reuse the row and
      // never claim a second offer: that is the state the fixture is supposed to represent.
      const [existing] = await tx.select().from(readingGenerationRuns)
        .where(and(eq(readingGenerationRuns.userId, user.id), eq(readingGenerationRuns.kind, "lifetime_free")))
        .for("update");
      if (existing) {
        if (existing.readingId && existing.readingId !== readingId && !replaceFree) {
          throw new SeedError(`free offer already points at reading ${existing.readingId}; pass --replace-free to repoint it`);
        }
        await tx.update(readingGenerationRuns).set({
          readingId, documentId: documentId, locale: sample.locale, status: "completed",
          consumedAt: now, finishedAt: now, contentVersion: FREE_CONTENT_VERSION,
        }).where(eq(readingGenerationRuns.id, existing.id));
        output.free = { documentId: documentId, runId: existing.id, reused: true };
      } else {
        const [run] = await tx.insert(readingGenerationRuns).values({
          userId: user.id, readingId, documentId: documentId, locale: sample.locale,
          status: "completed", consumedAt: now, finishedAt: now, contentVersion: FREE_CONTENT_VERSION,
        }).returning({ id: readingGenerationRuns.id });
        output.free = { documentId: documentId, runId: run.id, reused: false };
      }
    }

    if (mode === "paid" || mode === "both") {
      // Replace exactly what a previous seed wrote for this month; the run cascade removes its
      // edition and allowance, so no duplicate run or orphan allowance survives.
      const previous = await tx.select({ id: paidReadingRuns.id }).from(paidReadingRuns).where(and(
        eq(paidReadingRuns.userId, user.id),
        eq(paidReadingRuns.period, period),
        eq(paidReadingRuns.entitlementId, SEED_ENTITLEMENT),
      ));
      if (previous.length > 0) {
        await tx.delete(paidReadingRuns).where(inArray(paidReadingRuns.id, previous.map(row => row.id)));
      }

      const profile = report.profile as PaidProfile;
      const sections = paidSections(profile);
      const snapshot = calculatePaidSnapshot(readingId, corpus.input, profile);
      const snapshotHash = paidSnapshotHash(snapshot);
      const document = {
        ...buildReadingDocument({
          readingId, locale: sample.locale, tier: "paid",
          digest: paidDigest(snapshot), contentVersion: report.contentVersion, results,
        }),
        generatedAt: now.toISOString(),
        lockedSections: [],
        edition: { profile, expectedSections: [...sections], snapshotHash },
      };
      // Same rule as the free document: an edition with no generated section is never renderable
      // and would consume the month allowance for a page that answers `document_unavailable`.
      if (!persistableDocument(document)) {
        throw new SeedError(`report ${sample.caseId}/${sample.locale} has no generated section; refusing to write a paid edition the page cannot render`);
      }
      const generated = document.sections.filter(section => section.status === "generated").length;
      const [run] = await tx.insert(paidReadingRuns).values({
        userId: user.id, readingId, intentId: randomUUID(), period,
        allowancePolicy: PAID_ALLOWANCE_POLICY, locale: sample.locale, profile,
        expectedSections: [...sections], contentVersion: document.contentVersion,
        configHash: report.configHash, settings: { models: report.models, prices: null },
        policyHash: "b".repeat(64), consentRevision: 1, consentReceiptId: randomUUID(),
        entitlementId: SEED_ENTITLEMENT, entitlementUntil: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        controlRevision: 0, queueExpiresAt: now,
        status: generated === sections.length ? "completed" : "partial",
        consumedAt: now, finishedAt: now, completedSections: generated,
      }).returning({ id: paidReadingRuns.id });
      await tx.insert(paidReadingEditions).values({
        id: document.id, runId: run.id, readingId, locale: sample.locale, profile,
        expectedSections: [...sections], contentVersion: document.contentVersion,
        chartVersion: document.chartVersion, snapshotHash, snapshot, document,
      });
      // Mirror what accept() + finalization write: the month is reserved against this run and
      // consumed. Without this row the offer reports the month as available next to a completed
      // run, which is a state the product cannot produce.
      await tx.insert(paidReadingAllowances).values({ userId: user.id, period, runId: run.id, consumedAt: now });
      output.paid = { runId: run.id, editionId: document.id, period, allowance: "consumed" };
    }

    return output;
  });
}

seed().then(output => {
  console.log(JSON.stringify({ email, ...output }, null, 2));
}).catch(error => {
  fail(describeSeedError(error));
}).finally(async () => {
  // Without this the process lingers until the pool's idle timeout, which made a single seed take
  // over a minute; the run's output was already printed, so it read as a hang.
  await Promise.all([pool.end(), coordinationPool.end()]);
});
