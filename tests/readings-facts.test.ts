import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, coordinationPool } from "../src/db";
import { readings, readingChartFacts, readingGenerationConsents as consents, readingGenerationRuns as runs, users } from "../src/db/schema";
import { calculateSolarReturn, solarReturnFacts } from "../src/lib/solar";
import { canonicalHash } from "../src/readings/canonical-hash";
import {
  BASE_CALCULATION_POLICY, BASE_FACTS_BYTES, BASE_FACTS_HOUSE_SYSTEM, BASE_FACTS_SAVE_BYTES,
  BASE_FACTS_TOLERANCE_DEGREES, BASE_FACTS_VERSION, RETURN_SUN_TOLERANCE_DEGREES,
  baseFactsRow, baseFactsRowRejection, readBaseFacts,
} from "../src/readings/chart-facts";
import { handleChartSave } from "../src/readings/chart-save";
import { PDF_INPUT_BYTES, READING_LIMITS, ReadingViewError } from "../src/readings/presentation";
import { ReadingViewStore, loadReadingPresentation } from "../src/readings/reading-view";
import { ReadingPdfRenderer } from "../src/readings/pdf-render";
import { ReadingPdfError } from "../src/readings/pdf-contract";
import { pdfFixture } from "./helpers/reading-pdf";
import { readingChartInput } from "./helpers/reading-fixtures";
import type { ChartFacts } from "../src/lib/chart";
import type { ChartInput } from "../src/lib/types";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: !enabled ? "requires RUN_INTEGRATION_TESTS=1 and disposable local PostgreSQL" : false };

// Sentinels, so a leak is a failed assertion naming the value rather than a guess.
const input: ChartInput = {
  ...readingChartInput,
  name: "PRIVATE_RAW_NAME_SENTINEL",
  birthPlace: { ...readingChartInput.birthPlace, name: "PRIVATE_BIRTHPLACE_SENTINEL" },
  returnPlace: { ...readingChartInput.returnPlace, name: "PRIVATE_RETURNPLACE_SENTINEL" },
};
const result = calculateSolarReturn(input);
const facts = solarReturnFacts(input, result);
/** |latitude| >= 66: `castChart` refuses to approximate an angle, so there is no wheel. */
const polarInput: ChartInput = { ...input, returnPlace: { name: "PRIVATE_POLAR_SENTINEL", latitude: 69.6, longitude: 18.9, timezone: "Europe/Oslo" } };
const polarResult = calculateSolarReturn(polarInput);
const row = baseFactsRow(solarReturnFacts, input, result);
/**
 * The facts as the persisted contract describes them. `castChart` also emits a
 * redundant sign `index` on each angle that the contract does not declare, so the
 * stored form is the validated form rather than the raw engine output.
 */
const contractFacts = (() => {
  const read = readBaseFacts(facts, result);
  assert.ok("facts" in read);
  return read.facts;
})();

const allocated: string[] = [];
afterEach(async () => {
  if (!enabled) return;
  for (const id of allocated.splice(0)) await db.delete(users).where(eq(users.id, id));
});
after(async () => { await Promise.all([pool.end(), coordinationPool.end()]); });

function request(body: ChartInput) {
  return new Request("https://app.invalid/api/readings", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.invalid" }, body: JSON.stringify(body),
  });
}
async function account(verified = true) {
  const [user] = await db.insert(users).values({
    name: "Synthetic", email: `${randomUUID()}@example.invalid`, passwordHash: "not-a-real-hash",
    emailVerifiedAt: verified ? new Date() : null,
  }).returning();
  allocated.push(user.id);
  return user;
}
function saveDeps(user: { id: string; emailVerifiedAt: Date | null }) {
  return { user: async () => user, locale: "en" as const, budgets: async () => ({ allowed: true as const, retryAfterSeconds: 0 as const }) };
}
async function storedFacts(readingId: string) {
  return db.select().from(readingChartFacts).where(eq(readingChartFacts.readingId, readingId));
}
/** Narrow the two outcome unions the contract returns, so a row is never a silent null. */
const rowRejection = (outcome: ReturnType<typeof baseFactsRow>) => ("rejection" in outcome ? outcome.rejection : null);
const readRejection = (outcome: ReturnType<typeof readBaseFacts>) => ("rejection" in outcome ? outcome.rejection : null);

/**
 * Drizzle wraps driver failures, so the constraint identity lives on the cause. Assert
 * on the SQLSTATE and the constraint name: matching the message text would pass for the
 * wrong failure.
 */
function databaseError(code: string, constraint: string) {
  return (error: unknown) => {
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
    assert.equal(cause?.code, code, `SQLSTATE ${code}`);
    assert.equal(cause?.constraint, constraint);
    return true;
  };
}

/** Every console.warn/console.error payload emitted during `run`, parsed as log records. */
async function captured(t: TestContext, run: () => Promise<void>) {
  const lines: string[] = [];
  const warn = t.mock.method(console, "warn", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const error = t.mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  try { await run(); } finally { warn.mock.restore(); error.mock.restore(); }
  return lines.map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return { raw: line }; } });
}

// --------------------------------------------------------------------- contract

test("base facts: the coherence gate rejects every way the summary and the facts can disagree", () => {
  assert.ok("row" in row, "an ordinary chart must produce facts");
  assert.equal(row.row.factsVersion, BASE_FACTS_VERSION);
  assert.equal(row.row.calculationPolicy, BASE_CALCULATION_POLICY);
  assert.equal(row.row.houseSystem, BASE_FACTS_HOUSE_SYSTEM);
  assert.equal(row.row.chartVersion, "chart/2");
  assert.equal(row.row.factsHash, canonicalHash(row.row.facts), "the hash covers exactly the stored bytes");
  assert.deepEqual(row.row.facts, contractFacts, "what is stored is what the contract describes");
  assert.ok(!("index" in (row.row.facts.angles.ascendant as object)), "the undeclared redundant index is not persisted");

  const mutate = (change: (draft: ChartFacts) => void) => {
    const draft = structuredClone(facts);
    change(draft);
    const outcome = baseFactsRow(() => draft, input, result);
    assert.ok("rejection" in outcome, JSON.stringify(outcome).slice(0, 200));
    return outcome.rejection;
  };
  const sun = (draft: ChartFacts) => draft.bodies.find(item => item.body === "Sun")!;
  const moon = (draft: ChartFacts) => draft.bodies.find(item => item.body === "Moon")!;

  // The gates run in one order: the schema first, then agreement with the summary, then
  // size. Which one refuses a mutation is part of the contract, because the codes are
  // what gets logged: `invalid` means "this is not a base-facts/1 document at all",
  // while `incoherent` means "it is one, and it contradicts the summary beside it".
  const invalid = (change: (draft: ChartFacts) => void) => assert.equal(mutate(change), "invalid");
  const incoherent = (change: (draft: ChartFacts) => void) => assert.equal(mutate(change), "incoherent");

  // Not a document of this contract: a different house system or version, or a body list
  // that is not the ten bodies. A missing body is a different calculation, not a smaller
  // one; a duplicated body still has ten distinct names, so it is the schema's exact
  // length that catches it. The two gates are complementary, not redundant.
  invalid(draft => { draft.houseSystem = "placidus" as ChartFacts["houseSystem"]; });
  invalid(draft => { draft.chartVersion = "chart/1" as ChartFacts["chartVersion"]; });
  invalid(draft => { draft.bodies = draft.bodies.slice(0, 9); });
  invalid(draft => { draft.natal.bodies = draft.natal.bodies.slice(0, 9); });
  invalid(draft => { draft.bodies = [...draft.bodies, structuredClone(draft.bodies[0])]; });

  // A document of this contract that describes a different chart than the one saved.
  incoherent(draft => { draft.at = new Date(new Date(result.exactUtc).getTime() + 60_000).toISOString().replace("Z", "+00:00"); });
  // Angles: the wheel is oriented from the Ascendant, so it must be the same angle.
  incoherent(draft => { draft.angles.ascendant = null; });
  incoherent(draft => { draft.angles.ascendant!.longitude = (draft.angles.ascendant!.longitude + 1) % 360; });
  incoherent(draft => { draft.angles.midheaven.point = "Ascendant"; });
  // Houses exist exactly when the Ascendant does: twelve cusps or none, never a guess.
  incoherent(draft => { draft.houses = []; });
  // Twelve well-formed cusps that belong to the next sign along: the shape is right and
  // the orientation is wrong, which would draw a wheel contradicting its own table.
  incoherent(draft => { draft.houses = draft.houses.map(cusp => (cusp + 30) % 360); });
  incoherent(draft => { draft.houses = [...draft.houses.slice(1), draft.houses[0]!]; });
  // The summary's own Sun house and Moon must match the facts beside them.
  incoherent(draft => { sun(draft).house = (sun(draft).house ?? 1) % 12 + 1; });
  incoherent(draft => { sun(draft).house = null; });
  incoherent(draft => { moon(draft).longitude = (moon(draft).longitude + 0.5) % 360; });
  incoherent(draft => { sun(draft).longitude = (sun(draft).longitude + 0.5) % 360; });
});

test("base facts: rounding-level agreement passes and a different moment does not", () => {
  // Measured over 3168 charts: the largest Ascendant/Moon delta was 4.999e-5 degrees,
  // which is the 4-decimal rounding `castChart` applies and nothing else.
  const shift = (amount: number) => {
    const draft = structuredClone(facts);
    draft.angles.ascendant!.longitude = (draft.angles.ascendant!.longitude + amount) % 360;
    return baseFactsRow(() => draft, input, result);
  };
  assert.ok("row" in shift(BASE_FACTS_TOLERANCE_DEGREES / 2), "half the tolerance is rounding");
  assert.equal(rowRejection(shift(BASE_FACTS_TOLERANCE_DEGREES * 2)), "incoherent", "twice the tolerance is a different angle");

  // The return Sun is found by search, so it is near-identical rather than identical.
  const sunShift = (amount: number) => {
    const draft = structuredClone(facts);
    const sun = draft.bodies.find(item => item.body === "Sun")!;
    sun.longitude = (sun.longitude + amount) % 360;
    return baseFactsRow(() => draft, input, result);
  };
  assert.ok("row" in sunShift(RETURN_SUN_TOLERANCE_DEGREES / 2), "the searched return instant is allowed");
  // Roughly three minutes of solar motion: still a chart nobody would call the same one.
  assert.equal(rowRejection(sunShift(0.05)), "incoherent", "0.05 degrees of solar motion is about three minutes");
});

test("base facts: a chart with no Ascendant saves facts without a wheel instead of inventing one", () => {
  assert.equal(polarResult.ascendant, null, "the summary itself has no Ascendant at this latitude");
  assert.equal(solarReturnFacts(polarInput, polarResult).angles.ascendant, null);
  assert.deepEqual(solarReturnFacts(polarInput, polarResult).houses, []);
  const polar = baseFactsRow(solarReturnFacts, polarInput, polarResult);
  assert.ok("row" in polar, "no Ascendant is a coherent chart, not a failed one");
  assert.equal(polar.row.facts.angles.ascendant, null);
  assert.deepEqual(polar.row.facts.houses, []);
  const polarRead = readBaseFacts(polar.row.facts, polarResult);
  assert.ok("facts" in polarRead, "a wheel-less chart still reads back as facts");
  assert.equal(polarRead.facts.angles.ascendant, null);
});

test("base facts: oversize, malformed and throwing calculations are refused before anything is written", () => {
  const padded = structuredClone(facts);
  padded.aspects = Array.from({ length: 150 }, (_, index) => ({ ...padded.aspects[0]!, orb: index / 100 }));
  padded.crossAspects = Array.from({ length: 150 }, (_, index) => ({ ...padded.crossAspects[0]!, orb: index / 100 }));
  padded.warnings = Array.from({ length: 20 }, () => "w".repeat(512));
  assert.ok(Buffer.byteLength(JSON.stringify(padded)) > BASE_FACTS_SAVE_BYTES, "the fixture must actually exceed the save bound");
  assert.equal(rowRejection(baseFactsRow(() => padded, input, result)), "oversize");

  // Passes coherence but not the schema: proof the row is validated against the very
  // contract that will have to read it back.
  const unbalanced = structuredClone(facts);
  unbalanced.balance = { ...unbalanced.balance, fire: 999 };
  assert.equal(rowRejection(baseFactsRow(() => unbalanced, input, result)), "invalid");

  // Calculation errors can embed birth coordinates, so only a stable code survives.
  const thrown = baseFactsRow(() => { throw new Error(`cannot cast for ${input.birthPlace.latitude},${input.birthPlace.longitude}`); }, input, result);
  assert.equal(rowRejection(thrown), "calculation_failed");
  assert.ok(!("row" in thrown));
  assert.ok(!JSON.stringify(thrown).includes(String(input.birthPlace.latitude)), "no coordinate in the rejection");
});

test("base facts: a stored row is verified before it is rendered, and never trusted on shape alone", () => {
  assert.ok("row" in row);
  const stored = { ...row.row, facts: row.row.facts as unknown };
  assert.equal(baseFactsRowRejection(stored), null, "a clean row passes");
  for (const field of ["factsVersion", "calculationPolicy", "houseSystem", "chartVersion"] as const) {
    assert.equal(baseFactsRowRejection({ ...stored, [field]: "something-else" }), "invalid", field);
  }
  // The SELECT size-guard yields null instead of an oversized payload.
  assert.equal(baseFactsRowRejection({ ...stored, facts: null }), "oversize");
  // Tampering, however small, is a hash mismatch rather than a rendered wheel.
  const tampered = structuredClone(row.row.facts);
  tampered.bodies[0]!.longitude = (tampered.bodies[0]!.longitude + 0.0001) % 360;
  assert.equal(baseFactsRowRejection({ ...stored, facts: tampered }), "hash_mismatch");
  assert.equal(baseFactsRowRejection({ ...stored, factsHash: `${stored.factsHash}0` }), "hash_mismatch");

  assert.equal(readRejection(readBaseFacts(null, result)), "absent");
  assert.equal(readRejection(readBaseFacts(undefined, result)), "absent");
  assert.equal(readRejection(readBaseFacts({ ...row.row.facts, balance: { fire: 1 } }, result)), "invalid");
  const stale = structuredClone(row.row.facts);
  stale.at = new Date(new Date(result.exactUtc).getTime() + 3_600_000).toISOString().replace("Z", "+00:00");
  assert.equal(readRejection(readBaseFacts(stale, result)), "incoherent");
  const decoded = readBaseFacts(JSON.parse(JSON.stringify(row.row.facts)), result);
  assert.ok("facts" in decoded, "a JSONB round trip must still read back");
  assert.deepEqual(decoded.facts, row.row.facts, "byte-identically: no field is silently dropped on read");
});

test("base facts: derived positions only, never the birth identity they were derived from", () => {
  const serialized = JSON.stringify(facts);
  for (const secret of [input.name, input.birthPlace.name, input.returnPlace.name, input.birthDate, input.birthTime, "America/Tijuana"]) {
    assert.ok(!serialized.includes(secret), `facts must not carry ${secret}`);
  }
  // Coordinates are inputs, not facts: they must not ride along in any field.
  for (const coordinate of [input.birthPlace.latitude, input.birthPlace.longitude, input.returnPlace.latitude, input.returnPlace.longitude]) {
    assert.ok(!serialized.includes(String(coordinate)), `facts must not carry the coordinate ${coordinate}`);
  }
  assert.ok(serialized.includes("Sun") && serialized.includes(result.exactUtc), "the derived calculation itself is present");
  assert.ok(Buffer.byteLength(serialized) <= BASE_FACTS_BYTES);
});

test("base facts: the PDF input bound is one shared value that covers the facts a chart may carry", () => {
  // presentation.ts is client-safe and chart-facts.ts is server-only (node:crypto), so
  // the number is deliberately repeated; this is the tie that keeps them equal.
  assert.equal(READING_LIMITS.baseFactsBytes, BASE_FACTS_BYTES);
  assert.equal(PDF_INPUT_BYTES, READING_LIMITS.documentBytes + READING_LIMITS.chartBytes + READING_LIMITS.baseFactsBytes);
  // The two guards were once two independent spellings of the same bound.
  for (const file of ["src/readings/pdf-render.ts", "src/readings/pdf-worker.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("PDF_INPUT_BYTES"), `${file} must use the shared bound`);
    assert.ok(!source.includes("READING_LIMITS.documentBytes + READING_LIMITS.chartBytes"), `${file} must not respell the bound`);
  }
  // The stored-size CHECK and the read guard are the same number the contract states.
  assert.ok(readFileSync("drizzle/0009_reading_chart_facts.sql", "utf8").includes(`<= ${BASE_FACTS_BYTES}`));
});

test("base facts: the widest chart the save path can produce still passes the PDF preflight", async () => {
  const fixture = pdfFixture();
  const padded = structuredClone(facts);
  padded.warnings = Array.from({ length: 20 }, () => "w".repeat(512));
  // Fill the aspect list only as far as the save-side bound allows, so this is the widest
  // payload that could actually have been stored rather than one the schema permits.
  const aspects = (count: number) => Array.from({ length: count }, (_, index) => ({ ...padded.aspects[0]!, orb: index / 100 }));
  let count = 150;
  padded.aspects = aspects(count);
  while (count > 0 && Buffer.byteLength(JSON.stringify(padded)) > BASE_FACTS_SAVE_BYTES) padded.aspects = aspects(--count);
  fixture.chart.baseFacts = padded;
  const factsBytes = Buffer.byteLength(JSON.stringify(padded));
  // As close to the save-side bound as the schema allows, so this is the widest chart
  // that can legitimately reach a PDF rather than a payload nobody could have stored.
  assert.ok(factsBytes <= BASE_FACTS_SAVE_BYTES, `${factsBytes} must be storable`);
  assert.ok(factsBytes > BASE_FACTS_SAVE_BYTES * 0.8, "and must actually be near the bound");
  const serialized = Buffer.byteLength(JSON.stringify(fixture));
  assert.ok(serialized <= PDF_INPUT_BYTES, "the shared bound covers document, chart and facts");

  let forked = false;
  const preflight = new ReadingPdfRenderer({ spawn: () => { forked = true; throw new Error("must not fork in this test"); } });
  // The stub spawn throws, so reaching it at all is the proof: a size rejection would
  // have failed earlier with `pdf_input_limit` and never set `forked`.
  await assert.rejects(preflight.render(fixture),
    (error: unknown) => error instanceof ReadingPdfError && error.code === "pdf_unavailable");
  assert.equal(forked, true, "the size gate must let a facts-carrying chart through to the worker");

  // Recorded because it changes what the widened bound is for: with `freeText` and
  // `paidText` capping the prose far below `documentBytes`, no legitimate payload ever
  // reached the old `documentBytes + chartBytes` bound either. Widening it keeps the
  // stated contract true as facts join the chart, rather than fixing a live rejection.
  assert.ok(READING_LIMITS.paidText + READING_LIMITS.chartBytes + READING_LIMITS.baseFactsBytes < READING_LIMITS.documentBytes + READING_LIMITS.chartBytes);
});

// ------------------------------------------------------------------ persistence

test("saving a chart saves its calculation once, coherently, and still answers with only the id", gated, async t => {
  const user = await account();
  // Saving a chart must stay deterministic: the new facts write is more work in the same
  // request, so the zero-provider and zero-dispatch guarantees are re-asserted here.
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("saving must not call a provider"); });
  const saved = await handleChartSave(request(input), saveDeps(user));
  assert.equal(saved.status, 200);
  const value = await saved.json() as { id: string };
  assert.deepEqual(Object.keys(value), ["id"], "the save response shape is unchanged");

  const [chart] = await db.select().from(readings).where(eq(readings.id, value.id));
  assert.ok(chart, "the chart itself is saved");
  const rows = await storedFacts(value.id);
  assert.equal(rows.length, 1, "exactly one facts row, no duplicates");
  const stored = rows[0]!;
  assert.equal(stored.factsVersion, BASE_FACTS_VERSION);
  assert.equal(stored.calculationPolicy, BASE_CALCULATION_POLICY);
  assert.equal(stored.houseSystem, BASE_FACTS_HOUSE_SYSTEM);
  assert.equal(stored.chartVersion, "chart/2");
  assert.equal(stored.factsHash, canonicalHash(stored.facts));
  const recalculated = readBaseFacts(solarReturnFacts(input, chart.result), chart.result);
  assert.ok("facts" in recalculated);
  assert.equal(canonicalHash(stored.facts), canonicalHash(recalculated.facts),
    "the stored facts are the calculation, deterministically, after a JSONB round trip");
  assert.equal(baseFactsRowRejection({ ...stored, facts: stored.facts as unknown }), null);

  // Stored size is measured the way Postgres measures it, because jsonb re-serializes
  // with separator spacing JSON.stringify never adds: the save-side bound keeps that
  // margin so a payload this code accepts can never trip the stored-size CHECK.
  const [size] = await db.select({ stored: sql<number>`octet_length(${readingChartFacts.facts}::text)` })
    .from(readingChartFacts).where(eq(readingChartFacts.readingId, value.id));
  const compact = Buffer.byteLength(JSON.stringify(stored.facts));
  assert.ok(size!.stored <= BASE_FACTS_BYTES, "the stored payload fits the CHECK and the read guard");
  assert.ok(size!.stored >= compact, "jsonb re-serialization is never smaller");
  assert.ok(compact <= BASE_FACTS_SAVE_BYTES, "the save-side bound keeps the re-serialization margin");
  assert.ok(!JSON.stringify(stored.facts).includes(input.name), "no birth identity in the stored row");

  assert.equal(fetches, 0, "no provider call");
  assert.equal((await db.select({ id: runs.id }).from(runs).where(eq(runs.userId, user.id))).length, 0, "no generation dispatched");
  assert.equal((await db.select({ userId: consents.userId }).from(consents).where(eq(consents.userId, user.id))).length, 0, "no consent touched");
  assert.equal((await db.select({ id: readings.id }).from(readings).where(eq(readings.userId, user.id))).length, 1, "one save, one chart");
});

test("a chart whose facts cannot be produced still saves, and says so instead of guessing", gated, async t => {
  const user = await account();
  let status = 0; let keys: string[] = []; let charts = 0;
  const logs = await captured(t, async () => {
    const saved = await handleChartSave(request(input), { ...saveDeps(user), factsRow: () => ({ rejection: "calculation_failed" as const }) });
    status = saved.status;
    keys = Object.keys(await saved.json() as object);
    charts = (await db.select({ id: readings.id }).from(readings).where(eq(readings.userId, user.id))).length;
  });
  assert.equal(status, 200, "a facts failure is not a save failure");
  assert.deepEqual(keys, ["id"], "and the response shape does not change");
  assert.equal(charts, 1, "the chart is kept");
  const [row] = await db.select({ id: readings.id }).from(readings).where(eq(readings.userId, user.id));
  assert.equal((await storedFacts(row!.id)).length, 0, "no facts row is invented to fill the gap");
  const recorded = logs.find(entry => entry.event === "readings.facts_unavailable");
  assert.ok(recorded, "the gap is recorded");
  assert.equal(recorded!.code, "calculation_failed", "as a stable code");
  assert.equal(recorded!.readingId, row!.id);
  assert.ok(!JSON.stringify(recorded).includes(input.birthPlace.name), "never as raw birth input");
  assert.ok(!logs.some(entry => entry.event === "readings.save_failed"), "it is not reported as a failed save");
});

test("a facts row that cannot be written rolls the whole save back, leaving no orphan chart", gated, async t => {
  const user = await account();
  const trigger = `chart_facts_${randomUUID().replaceAll("-", "")}`;
  const sentinel = "PRIVATE_DATABASE_BODY_SENTINEL";
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${sentinel}' USING ERRCODE = '57014'; END $$`);
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON reading_chart_facts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try {
    const logs = await captured(t, async () => {
      const saved = await handleChartSave(request(input), saveDeps(user));
      assert.equal(saved.status, 500, "a half-written save is worse than a retryable failure");
      assert.deepEqual(await saved.json(), { error: "Unable to save your chart. Please try again." });
    });
    const failed = logs.find(entry => entry.event === "readings.save_failed");
    assert.ok(failed, "the failure is logged");
    assert.ok(!JSON.stringify(failed).includes(sentinel), "the database body is not serialized into logs");
    assert.equal((await db.select({ id: readings.id }).from(readings).where(eq(readings.userId, user.id))).length, 0, "no orphan chart row");
    assert.equal((await db.select({ id: readingChartFacts.id }).from(readingChartFacts)).length, 0, "no orphan facts row");
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON reading_chart_facts`);
    await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  }
});

test("reading a chart saved before facts existed neither recalculates nor backfills", gated, async t => {
  const user = await account();
  const [legacy] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
  const store = new ReadingViewStore();
  const logs = await captured(t, async () => {
    const view = await loadReadingPresentation({ id: user.id, emailVerifiedAt: new Date(), plan: "free" }, legacy.id, "en", { kind: "chart" }, { store });
    assert.equal(view.chart.id, legacy.id, "the chart still renders from its own summary");
    assert.equal(view.chart.baseFacts, undefined, "with no facts attached");
    assert.deepEqual(view.chart.result.moon, result.moon);
  });
  assert.equal((await storedFacts(legacy.id)).length, 0, "the read did not write anything");
  assert.equal((await db.select({ at: readings.createdAt }).from(readings).where(eq(readings.id, legacy.id))).length, 1);
  assert.ok(!logs.some(entry => entry.event === "readings.facts_rejected"), "an ordinary pre-facts chart is not a defect");
});

test("a tampered stored row renders as absent, not as a wrong wheel or a 500", gated, async t => {
  const user = await account();
  const saved = await handleChartSave(request(input), saveDeps(user));
  const { id } = await saved.json() as { id: string };
  const tampered = structuredClone(facts);
  tampered.bodies.find(item => item.body === "Moon")!.longitude = (result.moon.longitude + 12) % 360;
  await db.update(readingChartFacts).set({ facts: tampered }).where(eq(readingChartFacts.readingId, id));

  const store = new ReadingViewStore();
  const logs = await captured(t, async () => {
    const view = await loadReadingPresentation({ id: user.id, emailVerifiedAt: new Date(), plan: "free" }, id, "en", { kind: "chart" }, { store });
    assert.equal(view.chart.baseFacts, undefined, "untrusted facts are not rendered");
    assert.deepEqual(view.chart.result.moon, result.moon, "the summary is untouched");
  });
  const rejected = logs.find(entry => entry.event === "readings.facts_rejected");
  assert.ok(rejected, "the defect is recorded");
  assert.equal(rejected!.code, "hash_mismatch");
  assert.equal(rejected!.readingId, id);
  assert.ok(!JSON.stringify(rejected).includes(JSON.stringify(tampered).slice(0, 40)), "the payload is not logged");
});

test("an unknown facts version is ignored, so old code keeps reading the row it understands", gated, async t => {
  const user = await account();
  const saved = await handleChartSave(request(input), saveDeps(user));
  const { id } = await saved.json() as { id: string };
  // A future contract is a new row under a new version, never a rewrite of this one.
  await db.insert(readingChartFacts).values({
    readingId: id, factsVersion: "base-facts/9", calculationPolicy: "future-policy", houseSystem: BASE_FACTS_HOUSE_SYSTEM,
    chartVersion: "chart/2", facts, factsHash: canonicalHash(facts),
  });
  await assert.rejects(async () => db.insert(readingChartFacts).values({
    readingId: id, factsVersion: BASE_FACTS_VERSION, calculationPolicy: BASE_CALCULATION_POLICY, houseSystem: BASE_FACTS_HOUSE_SYSTEM,
    chartVersion: "chart/2", facts, factsHash: canonicalHash(facts),
  }), databaseError("23505", "reading_chart_facts_reading_version_key"), "one immutable row per chart and version");

  const store = new ReadingViewStore();
  const rows = await captured(t, async () => {
    const chartRow = await store.chart(user.id, id);
    assert.ok(chartRow, "the chart query still returns exactly the chart");
    assert.equal((chartRow as Record<string, unknown>).factsVersion, undefined,
      "and is untouched by the facts contract: no join, no extra columns, no extra rows");
    const stored = await store.facts(user.id, id);
    assert.equal(stored?.factsVersion, BASE_FACTS_VERSION, "the facts read picks the version this code understands");
    const view = await loadReadingPresentation({ id: user.id, emailVerifiedAt: new Date(), plan: "free" }, id, "en", { kind: "chart" }, { store });
    assert.equal(canonicalHash(view.chart.baseFacts), canonicalHash(contractFacts), "the known row still renders");
  });
  assert.equal((await storedFacts(id)).length, 2, "both rows survive; nothing was rewritten");
  assert.ok(!rows.some(entry => entry.event === "readings.facts_rejected"), "a newer version is not a defect");

  // A chart whose only row is a version this code does not know has no facts, honestly.
  const [other] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
  await db.insert(readingChartFacts).values({
    readingId: other!.id, factsVersion: "base-facts/9", calculationPolicy: "future-policy", houseSystem: BASE_FACTS_HOUSE_SYSTEM,
    chartVersion: "chart/2", facts, factsHash: canonicalHash(facts),
  });
  const quiet = await captured(t, async () => {
    const view = await loadReadingPresentation({ id: user.id, emailVerifiedAt: new Date(), plan: "free" }, other!.id, "en", { kind: "chart" }, { store });
    assert.equal(view.chart.baseFacts, undefined);
  });
  assert.ok(!quiet.some(entry => entry.event === "readings.facts_rejected"));
});

test("facts are private to their chart's owner and disappear with it", gated, async () => {
  const owner = await account();
  const stranger = await account();
  const saved = await handleChartSave(request(input), saveDeps(owner));
  const { id } = await saved.json() as { id: string };
  assert.equal((await storedFacts(id)).length, 1);

  const store = new ReadingViewStore();
  assert.equal(await store.chart(stranger.id, id), null, "the join does not weaken the ownership filter");
  await assert.rejects(
    loadReadingPresentation({ id: stranger.id, emailVerifiedAt: new Date(), plan: "free" }, id, "en", { kind: "chart" }, { store }),
    (error: unknown) => error instanceof ReadingViewError && error.code === "not_found");

  await db.delete(readings).where(eq(readings.id, id));
  assert.equal((await storedFacts(id)).length, 0, "facts cascade with the chart");
  const second = await handleChartSave(request(input), saveDeps(owner));
  const { id: kept } = await second.json() as { id: string };
  assert.notEqual(kept, id, "a second save of the same input is a second reading");
  const keptFacts = await storedFacts(kept);
  assert.equal(keptFacts.length, 1, "with its own facts row");
  assert.notEqual(keptFacts[0]!.readingId, id, "pointing at its own chart, not the deleted one");
  await db.delete(users).where(eq(users.id, owner.id));
  assert.equal((await storedFacts(kept)).length, 0, "and with the account");
});

test("the stored payload cannot exceed the bound, so an oversized row cannot exist", gated, async () => {
  const user = await account();
  const [chart] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
  const bloated = { ...facts, warnings: Array.from({ length: 400 }, () => "w".repeat(512)) };
  assert.ok(Buffer.byteLength(JSON.stringify(bloated)) > BASE_FACTS_BYTES);
  await assert.rejects(async () => db.insert(readingChartFacts).values({
    readingId: chart!.id, factsVersion: BASE_FACTS_VERSION, calculationPolicy: BASE_CALCULATION_POLICY,
    houseSystem: BASE_FACTS_HOUSE_SYSTEM, chartVersion: "chart/2", facts: bloated, factsHash: canonicalHash(bloated),
  }), databaseError("23514", "chart_facts_size_check"), "the database enforces the same bound the read path does");
  assert.equal((await storedFacts(chart!.id)).length, 0);
});

test("migration 0009 is additive: existing rows and readings.result bytes survive untouched", gated, async () => {
  // The same upgrade harness tests/readings-migrations.test.ts uses: build a database at
  // the previous journal entry, put real rows in it, then apply the rest.
  const baseUrl = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname), "never rehearse against hosted data");
  const databaseName = `facts_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: baseUrl.toString(), max: 1 });
  const folder = await mkdtemp(path.join(os.tmpdir(), "solara-facts-upgrade-"));
  let upgraded: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    baseUrl.pathname = `/${databaseName}`;
    upgraded = new Pool({ connectionString: baseUrl.toString(), max: 2 });
    const database = drizzle(upgraded);

    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const previous = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx <= 8) };
    assert.equal(previous.entries.at(-1).tag, "0008_paid_annual_facts", "0009 must be the migration under test");
    await mkdir(path.join(folder, "meta"));
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
    for (const entry of previous.entries) await copyFile(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`));
    await migrate(database, { migrationsFolder: folder });

    const [user] = await database.insert(users).values({
      name: "Legacy fixture", email: `${randomUUID()}@example.invalid`, passwordHash: "not-a-real-hash", emailVerifiedAt: new Date(),
    }).returning();
    const [chart] = await database.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
    const before = async () => (await database.select({
      rows: sql<number>`(select count(*) from readings)::int`,
      stored: sql<number>`octet_length(${readings.result}::text)`,
      digest: sql<string>`encode(sha256(${readings.result}::text::bytea), 'hex')`,
      serialized: sql<string>`${readings.result}::text`,
    }).from(readings).where(eq(readings.id, chart!.id)))[0]!;
    const prior = await before();
    assert.equal(prior.rows, 1);

    await assert.doesNotReject(() => migrate(database, { migrationsFolder: "drizzle" }), "0009 must apply over a populated 0008 database");
    const after = await before();
    assert.equal(after.rows, 1, "the row is still there");
    assert.equal(after.stored, prior.stored, "and its stored size is unchanged");
    assert.equal(after.digest, prior.digest, "readings.result bytes are byte-identical");
    assert.equal(after.serialized, prior.serialized);

    const factsRows = await database.select({ id: readingChartFacts.id }).from(readingChartFacts);
    assert.equal(factsRows.length, 0, "the migration adds a table; it does not backfill it");

    // The upgraded instance reads the pre-existing chart exactly as before, with no facts.
    const view = await loadReadingPresentation(
      { id: user.id, emailVerifiedAt: new Date(), plan: "free" }, chart!.id, "en", { kind: "chart" },
      { store: new ReadingViewStore(database) },
    );
    assert.equal(view.chart.baseFacts, undefined);
    assert.ok(!("baseFacts" in view.chart), "absent facts must not add a key, so the serialized view is unchanged");
    assert.deepEqual(view.chart.result.moon, result.moon);

    // The upgraded table is usable, and its constraints came with it.
    await database.insert(readingChartFacts).values({
      readingId: chart!.id, factsVersion: BASE_FACTS_VERSION, calculationPolicy: BASE_CALCULATION_POLICY,
      houseSystem: BASE_FACTS_HOUSE_SYSTEM, chartVersion: "chart/2", facts: contractFacts, factsHash: canonicalHash(contractFacts),
    });
    assert.equal((await database.select({ id: readingChartFacts.id }).from(readingChartFacts)).length, 1);
    await assert.rejects(async () => database.insert(readingChartFacts).values({
      readingId: chart!.id, factsVersion: BASE_FACTS_VERSION, calculationPolicy: BASE_CALCULATION_POLICY,
      houseSystem: BASE_FACTS_HOUSE_SYSTEM, chartVersion: "chart/2", facts: contractFacts, factsHash: canonicalHash(contractFacts),
    }), databaseError("23505", "reading_chart_facts_reading_version_key"), "the unique index survived the upgrade");
  } finally {
    await upgraded?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  }
});
