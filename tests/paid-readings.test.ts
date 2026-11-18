import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ReadingPdfRenderer } from "../src/readings/pdf-render";
import { inspectPdf } from "./helpers/reading-pdf";
import test, { after, afterEach, beforeEach } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { db, pool, coordinationPool } from "../src/db";
import { users, readings, subscriptions, readingDocuments, readingGenerationRuns as freeRuns, paidReadingRuns as runs, paidReadingAllowances as allowances,
  paidReadingAttempts as attempts, paidReadingCheckpoints as checkpoints, paidReadingSnapshots as snapshots, paidReadingEditions as editions, paidReadingApprovals as approvals, paidReadingControl as controls } from "../src/db/schema";
import { calculateSolarReturn } from "../src/lib/solar";
import { withAccountLifecycleLock } from "../src/lib/account-lifecycle-lock";
import { GenerationStore } from "../src/readings/generation-store";
import { processorProfile } from "../src/readings/policy";
import { liveGenerationConfig } from "../src/readings/policy";
import { paidGenerationConfig } from "../src/readings/paid-policy";
import { PaidReadingStore } from "../src/readings/paid-store";
import { handlePaidReading, handlePaidStop, type PaidHttpDeps } from "../src/readings/paid-http";
import { executePaidRun, workOnePaidReading } from "../src/readings/paid-worker";
import { PAID_CORE_SECTIONS, PAID_PROFILE, PAID_RICH_PROFILE, PAID_RICH_SECTIONS, type PaidOffer, type PaidRunView } from "../src/readings/paid-contract";
import { calculatePaidSnapshot, paidSnapshotHash, readPaidSnapshot } from "../src/readings/paid-chart";
import { loadReadingPresentation, ReadingViewStore } from "../src/readings/reading-view";
import { readStoredDocument } from "../src/readings/stored-document";
import { readingSelector } from "../src/readings/chart-presentation";
import { handleReadingPdf } from "../src/readings/pdf-http";
import { readingChartInput, frozenReading } from "./helpers/reading-fixtures";
import type { ChartInput } from "../src/lib/types";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: enabled ? false : "requires disposable local PostgreSQL and RUN_INTEGRATION_TESTS=1" };
const envKeys = ["READINGS_GENERATION_ENABLED", "READINGS_PAID_GENERATION_ENABLED", "READINGS_PAID_EXECUTOR", "READINGS_PAID_PROFILE", "READINGS_PROVIDER", "READINGS_CHEAP_MODEL", "READINGS_STRONG_MODEL", "READINGS_API_BASE_URL", "READINGS_API_KEY", "READINGS_PROCESSOR_PROFILE", "READINGS_MODEL_PRICES", "READINGS_REQUEST_TIMEOUT_MS"];
let savedEnv: Record<string, string | undefined>;
const allocated: string[] = [];
const approvalHashes = new Set<string>();
const store = new PaidReadingStore();
const free = new GenerationStore();
const input: ChartInput = { ...readingChartInput, name: "PRIVATE_PAID_NAME_SENTINEL" };
const profile = { id: "paid-synthetic-processor", name: "Synthetic paid test processor", policyVersion: "test-v1",
  inputTokenLimits: { "paid-cheap": 6000, "paid-strong": 8000 }, servedModels: { "paid-cheap": ["paid-cheap", "paid-cheap-alias"], "paid-strong": ["paid-strong", "paid-strong-alias"] } };
const prices = { "paid-cheap": { inputMxnPerMillion: 15, outputMxnPerMillion: 60 }, "paid-cheap-alias": { inputMxnPerMillion: 15, outputMxnPerMillion: 60 },
  "paid-strong": { inputMxnPerMillion: 30, outputMxnPerMillion: 120 }, "paid-strong-alias": { inputMxnPerMillion: 30, outputMxnPerMillion: 120 } };

beforeEach(async () => {
  if (!enabled) return;
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL!).hostname), "disposable loopback database only");
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { READINGS_GENERATION_ENABLED: "true", READINGS_PAID_GENERATION_ENABLED: "true", READINGS_PAID_EXECUTOR: "database-worker-v1", READINGS_PAID_PROFILE: PAID_PROFILE,
    READINGS_PROVIDER: "chat-completions", READINGS_CHEAP_MODEL: "paid-cheap", READINGS_STRONG_MODEL: "paid-strong", READINGS_API_BASE_URL: "https://processor.invalid/v1",
    READINGS_API_KEY: "FAKE_PAID_PROVIDER_KEY", READINGS_PROCESSOR_PROFILE: JSON.stringify(profile), READINGS_MODEL_PRICES: JSON.stringify(prices), READINGS_REQUEST_TIMEOUT_MS: "2000" });
  await store.setEnabled(true);
});
afterEach(async () => {
  if (!enabled) return;
  for (const id of allocated.splice(0)) await db.delete(users).where(eq(users.id, id));
  for (const hash of approvalHashes) await db.delete(approvals).where(eq(approvals.configHash, hash));
  approvalHashes.clear();
  await store.setEnabled(false);
  for (const key of envKeys) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
});
after(async () => { await Promise.all([pool.end(), coordinationPool.end()]); });

async function account(options: { entitled?: boolean; verified?: boolean; input?: ChartInput; status?: string } = {}) {
  const [user] = await db.insert(users).values({ name: "Synthetic paid account", email: `${randomUUID()}@example.invalid`, passwordHash: "unused-fixture-hash",
    emailVerifiedAt: options.verified === false ? null : new Date(), plan: "free" }).returning();
  allocated.push(user.id);
  const chartInput = options.input ?? input;
  const [chart] = await db.insert(readings).values({ userId: user.id, year: chartInput.year, input: chartInput, result: calculateSolarReturn(chartInput) }).returning();
  if (options.entitled !== false) await db.insert(subscriptions).values({ userId: user.id, stripeSubscriptionId: `sub_${randomUUID()}`, stripeCustomerId: `cus_${randomUUID()}`,
    stripePriceId: "price_synthetic", status: options.status ?? "active", currency: "mxn", grantsAccess: true, currentPeriodEnd: new Date(Date.now() + 86_400_000) });
  return { user, chart, viewer: { id: user.id, emailVerifiedAt: user.emailVerifiedAt, plan: "free" as const } };
}
const output = { blocks: [{ kind: "prose" as const, text: "A synthetic complete section. Not an evaluated live interpretation." }] };
function response(model: string, changes: Record<string, unknown> = {}) {
  return Response.json({ model, usage: { prompt_tokens: 100, completion_tokens: 100 }, choices: [{ message: { content: JSON.stringify(output) } }], ...changes });
}
function fake(modify?: (call: number, wire: Record<string, unknown>, signal?: AbortSignal | null) => Promise<Response> | Response) {
  const payloads: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (_url, init) => {
    const wire = JSON.parse(String(init?.body)); payloads.push(wire);
    return modify ? modify(payloads.length, wire, init?.signal) : response(wire.model);
  };
  return { transport, payloads, config: () => paidGenerationConfig(transport) };
}
async function ready(config: ReturnType<typeof paidGenerationConfig>) {
  assert.ok(config);
  for (const locale of ["en", "es"] as const) await db.insert(approvals).values({ profile: config.editionProfile, contentVersion: config.contentVersion, configHash: config.fingerprint,
    locale, sampleCount: 6, reviewer: "Synthetic protocol fixture, NOT live editorial approval", evidence: "tests/paid-readings.test.ts: synthetic only" }).onConflictDoNothing();
  approvalHashes.add(config.fingerprint);
  await store.announceWorker(config);
  return config;
}
function req(method: string, body?: unknown, query = "") {
  return new Request(`https://app.invalid/api/readings/id/paid${query}`, { method, headers: { "Content-Type": "application/json", Origin: "https://app.invalid" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function options(a: Awaited<ReturnType<typeof account>>, f: ReturnType<typeof fake>, replacement = store): PaidHttpDeps {
  return { user: async () => a.user, locale: "en", store: replacement, config: f.config, throttle: async () => null };
}
async function accept(a: Awaited<ReturnType<typeof account>>, f: ReturnType<typeof fake>, locale: "en" | "es" = "en") {
  const config = await ready(f.config());
  await free.grant(a.user.id, processorProfile()!, 0, locale);
  const deps = options(a, f);
  const offered = await handlePaidReading(req("GET", undefined, `?locale=${locale}`), a.chart.id, deps);
  assert.equal(offered.status, 200);
  const offer = await offered.json() as PaidOffer;
  assert.equal(offer.available, true);
  const intent = { requestId: randomUUID(), locale, period: offer.period, profile: config.editionProfile, offerHash: offer.offerHash };
  const accepted = await handlePaidReading(req("POST", intent), a.chart.id, deps);
  assert.equal(accepted.status, 202, JSON.stringify(await accepted.clone().json()));
  return { run: await accepted.json() as PaidRunView, intent, config, deps, offer };
}
async function ledger(id: string) {
  return { run: (await db.select().from(runs).where(eq(runs.id, id)))[0], attempts: await db.select().from(attempts).where(eq(attempts.runId, id)),
    checkpoints: await db.select().from(checkpoints).where(eq(checkpoints.runId, id)), snapshot: await db.select().from(snapshots).where(eq(snapshots.runId, id)),
    editions: await db.select().from(editions).where(eq(editions.runId, id)) };
}
function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }

// These tests use the actual route boundary, database ledger and transport adapter.
test("paid-first intent queues without provider work, survives browser closure, publishes nine sections and pins HTML/PDF after expiry", gated, async () => {
  const a = await account(); const f = fake(); const accepted = await accept(a, f);
  assert.equal(accepted.run.status, "queued"); assert.equal(f.payloads.length, 0);
  assert.equal((await db.select().from(freeRuns).where(eq(freeRuns.userId, a.user.id))).length, 0, "paid-first does not consume free");
  assert.equal((await ledger(accepted.run.id)).run.consumedAt, null);
  const finished = await workOnePaidReading({ store, config: f.config });
  assert.equal(finished?.status, "completed"); assert.ok(finished?.editionId); assert.equal(f.payloads.length, 9);
  assert.equal(f.payloads.at(-1)?.model, "paid-strong");
  const state = await ledger(accepted.run.id);
  assert.ok(state.run.consumedAt); assert.equal(state.attempts.length, 9); assert.equal(state.editions.length, 1);
  assert.equal(state.checkpoints.length, 0); assert.equal(state.snapshot.length, 0, "private checkpoint data is cleaned after immutable publication");
  assert.deepEqual(state.editions[0].document.sections.map(section => section.key), PAID_CORE_SECTIONS);
  assert.equal(state.editions[0].document.sections[0].closingQuestion, undefined, "paid overview needs no free upsell question");
  assert.deepEqual((await db.select().from(readings).where(eq(readings.id, a.chart.id)))[0].result, a.chart.result, "free whole-sign chart stays unchanged");
  await db.update(subscriptions).set({ status: "canceled", grantsAccess: false, currentPeriodEnd: new Date(0) }).where(eq(subscriptions.userId, a.user.id));
  await free.withdraw(a.user.id, "es"); process.env.READINGS_GENERATION_ENABLED = "false";
  const view = await loadReadingPresentation(a.viewer, a.chart.id, "es", { kind: "paid", id: finished.editionId });
  assert.equal(view.content.kind, "saved-reading"); assert.equal(view.content.locale, "en"); assert.equal(view.chart.result.houseSystem, "Placidus");
  assert.ok(view.chart.calculation?.length); assert.equal(view.content.sections.length, 9);
  execFileSync(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "pipe" });
  const renderer = new ReadingPdfRenderer();
  const pdf = await handleReadingPdf(new Request(`https://app.invalid/api/readings/${a.chart.id}/pdf?paidEdition=${finished.editionId}`), a.chart.id, {
    user: async () => a.viewer, locale: "es", throttle: async () => null, renderer: { render: async projected => {
      assert.deepEqual(projected, { chart: view.chart, content: view.content });
      return renderer.render(projected);
    } },
  });
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get("cache-control"), "private, no-store"); assert.equal(f.payloads.length, 9);
  const rendered = await inspectPdf(Buffer.from(await pdf.arrayBuffer()));
  assert.equal(rendered.metadata.Language, "en"); assert.ok(rendered.text.includes("Placidus"));
  for (const section of view.content.sections) assert.ok(rendered.text.includes(section.title));
  assert.equal((rendered.text.match(/A synthetic complete section/g) ?? []).length, 9);
  const canonical = await loadReadingPresentation(a.viewer, a.chart.id, "en");
  assert.equal(canonical.content.kind, "chart-notes", "paid never becomes implicit latest/free selection");
});

test("paid handler denies unverified/non-owner/unentitled/forged intent and does not trust users.plan", gated, async () => {
  const a = await account({ entitled: false }); const other = await account(); const f = fake(); const config = await ready(f.config());
  await db.update(users).set({ plan: "paid" }).where(eq(users.id, a.user.id));
  await free.grant(a.user.id, processorProfile()!, 0, "en");
  const deps = options(a, f);
  const offer = await store.offer(a.user.id, a.chart.id, "en", config, true);
  const intent = { requestId: randomUUID(), locale: "en", profile: PAID_PROFILE, period: offer.period, offerHash: offer.offerHash };
  assert.equal((await handlePaidReading(req("POST", intent), a.chart.id, { ...deps, user: async () => null })).status, 401);
  assert.equal((await handlePaidReading(req("POST", intent), a.chart.id, { ...deps, user: async () => ({ ...a.user, emailVerifiedAt: null }) })).status, 401);
  assert.equal((await handlePaidReading(req("POST", intent), other.chart.id, deps)).status, 404);
  assert.equal((await handlePaidReading(req("POST", intent), a.chart.id, deps)).status, 403);
  assert.equal((await handlePaidReading(req("POST", { ...intent, tier: "free", digest: {} }), a.chart.id, deps)).status, 400);
  assert.equal((await handlePaidReading(req("GET", undefined, "?locale=en&locale=es"), a.chart.id, deps)).status, 400);
  assert.equal((await db.select().from(runs).where(eq(runs.userId, a.user.id))).length, 0); assert.equal(f.payloads.length, 0);
});

test("racing intents reserve once; exact replay is a no-op even when disabled; no monthly/subscription stacking", gated, async () => {
  const a = await account({ status: "trialing" }); const f = fake(); const accepted = await accept(a, f);
  await db.insert(subscriptions).values({ userId: a.user.id, stripeSubscriptionId: `sub_${randomUUID()}`, stripeCustomerId: "cus_other", stripePriceId: "price_other", status: "active", grantsAccess: true, currency: "usd", currentPeriodEnd: new Date(Date.now() + 86_400_000) });
  const answers = await Promise.all(Array.from({ length: 5 }, (_, i) => handlePaidReading(req("POST", { ...accepted.intent, requestId: i ? randomUUID() : accepted.intent.requestId }), a.chart.id, accepted.deps)));
  assert.deepEqual(answers.map(answer => answer.status), [202, 409, 409, 409, 409]);
  assert.equal((await db.select().from(allowances).where(eq(allowances.userId, a.user.id))).length, 1);
  process.env.READINGS_PAID_GENERATION_ENABLED = "false";
  const replay = await handlePaidReading(req("POST", accepted.intent), a.chart.id, accepted.deps);
  assert.equal(replay.status, 202); assert.equal((await replay.json()).id, accepted.run.id); assert.equal(f.payloads.length, 0);
});

test("unsupported Placidus fails pre-permit and releases reservation without touching the free offer", gated, async () => {
  const a = await account({ input: { ...input, returnPlace: { name: "Synthetic polar location", latitude: 67, longitude: 20, timezone: "Europe/Stockholm" } } });
  const f = fake(); const accepted = await accept(a, f);
  const finished = await workOnePaidReading({ store, config: f.config });
  assert.equal(finished?.status, "failed"); assert.equal(finished?.reason, "placidus_unavailable"); assert.equal(f.payloads.length, 0);
  const state = await ledger(accepted.run.id); assert.equal(state.run.consumedAt, null); assert.equal(state.attempts.length, 0);
  assert.equal((await db.select().from(allowances).where(eq(allowances.userId, a.user.id))).length, 0);
  assert.equal((await db.select().from(freeRuns).where(eq(freeRuns.userId, a.user.id))).length, 0);
});

test("paid config validates strong model/aliases and worst-case repairs without breaking free config", gated, async () => {
  const f = fake(); assert.ok(f.config());
  process.env.READINGS_STRONG_MODEL = "fixture-1";
  assert.equal(f.config(), null); assert.ok(liveGenerationConfig(f.transport));
  process.env.READINGS_STRONG_MODEL = "paid-strong";
  process.env.READINGS_MODEL_PRICES = JSON.stringify({ ...prices, "paid-strong-alias": { inputMxnPerMillion: 31, outputMxnPerMillion: 120 } });
  assert.equal(f.config(), null); assert.ok(liveGenerationConfig(f.transport));
  process.env.READINGS_MODEL_PRICES = JSON.stringify({ ...prices, "paid-strong": { inputMxnPerMillion: 600, outputMxnPerMillion: 1000 }, "paid-strong-alias": { inputMxnPerMillion: 600, outputMxnPerMillion: 1000 } });
  assert.equal(f.config(), null, "all possible primaries and repairs must fit ten MXN"); assert.ok(liveGenerationConfig(f.transport));
});

test("actual paid wire payload is Placidus, privacy-allowlisted, capped, and has no free cliffhanger contract", gated, async () => {
  const a = await account(); const f = fake(); await accept(a, f);
  await workOnePaidReading({ store, config: f.config });
  assert.equal(f.payloads.length, 9);
  for (const wire of f.payloads) {
    const text = JSON.stringify(wire);
    assert.match(text, /placidus/);
    for (const secret of [input.name, input.birthDate, input.birthPlace.name, input.returnPlace.name, a.user.email, a.user.id, "FAKE_PAID_PROVIDER_KEY"]) assert.equal(text.includes(secret), false, secret);
    assert.equal(wire.max_tokens, 2000);
  }
  const overview = JSON.stringify(f.payloads[0]); assert.match(overview, /complete, paid solar-return/); assert.doesNotMatch(overview, /whole-sign house and/);
});

test("paid completeness is the frozen nine-section manifest, never just overview/Sun", gated, async () => {
  const a = await account(); const f = fake(); const accepted = await accept(a, f);
  assert.equal((await workOnePaidReading({ store, config: f.config }))?.status, "completed");
  const [edition] = (await ledger(accepted.run.id)).editions; assert.ok(edition);
  const document = edition.document;
  const incomplete = { ...document, sections: document.sections.slice(0, 2) };
  const decoded = readStoredDocument(JSON.stringify(incomplete), incomplete, { allowPaid: true });
  assert.ok(decoded.ok); assert.equal(decoded.value.partial, true); assert.ok(decoded.value.notices.includes("missing_sections"));
  const intact = readStoredDocument(JSON.stringify(document), document, { allowPaid: true, expectedSections: PAID_CORE_SECTIONS });
  assert.ok(intact.ok); assert.equal(intact.value.partial, false);
  assert.deepEqual(readingSelector(new URLSearchParams(`paidEdition=${document.id}`)), { kind: "paid", id: document.id });
  assert.throws(() => readingSelector(new URLSearchParams(`paidEdition=${document.id}&document=${document.id}`)), /invalid_selection/);
});

test("paid snapshot hashing survives JSONB ordering and matches frozen Placidus display", gated, async () => {
  const a = await account(); const f = fake(); const accepted = await accept(a, f); await workOnePaidReading({ store, config: f.config });
  const edition = (await ledger(accepted.run.id)).editions[0]; const snapshot = readPaidSnapshot(edition.snapshot);
  assert.equal(paidSnapshotHash(snapshot), edition.snapshotHash);
  assert.deepEqual(snapshot.facts.houses.length, 12); assert.equal(snapshot.chart.result.sunHouse, snapshot.facts.bodies.find(body => body.body === "Sun")?.house);
  await assert.rejects(() => db.update(editions).set({ contentVersion: "overwrite" }).where(eq(editions.id, edition.id)), error => (error as { cause?: { code?: string } }).cause?.code === "23514");
});

test("foreign and legacy paid rows are not authorized editions; free canonical document remains identical", gated, async () => {
  const a = await account(); const b = await account(); const f = fake();
  const document = { ...frozenReading("en", "free"), id: randomUUID(), readingId: a.chart.id };
  await db.insert(readingDocuments).values({ id: document.id, readingId: a.chart.id, locale: "en", contentVersion: document.contentVersion, chartVersion: document.chartVersion, tier: "free", document });
  await db.insert(freeRuns).values({ userId: a.user.id, readingId: a.chart.id, documentId: document.id, locale: "en", status: "completed", consumedAt: new Date(), contentVersion: document.contentVersion });
  const before = await loadReadingPresentation(a.viewer, a.chart.id, "en");
  const accepted = await accept(a, f); const finished = await workOnePaidReading({ store, config: f.config }); assert.ok(finished?.editionId);
  assert.deepEqual(await loadReadingPresentation(a.viewer, a.chart.id, "en"), before);
  await assert.rejects(() => loadReadingPresentation(b.viewer, a.chart.id, "en", { kind: "paid", id: finished.editionId! }), /not_found/);
  await assert.rejects(() => loadReadingPresentation(a.viewer, a.chart.id, "en", { kind: "document", id: finished.editionId! }), /not_found/);
  const legacy = { ...document, id: randomUUID(), tier: "paid" as const, contentVersion: "unproven-paid" };
  await db.insert(readingDocuments).values({ id: legacy.id, readingId: a.chart.id, locale: "en", contentVersion: legacy.contentVersion, chartVersion: legacy.chartVersion, tier: "paid", document: legacy });
  await assert.rejects(() => loadReadingPresentation(a.viewer, a.chart.id, "en", { kind: "paid", id: legacy.id }), /not_found/);
  assert.equal((await ledger(accepted.run.id)).editions.length, 1);
});

async function claimed(a: Awaited<ReturnType<typeof account>>, f: ReturnType<typeof fake>) {
  const accepted = await accept(a, f);
  const run = await store.claimNext(accepted.config, () => true); assert.ok(run); assert.equal(run.id, accepted.run.id);
  await store.saveSnapshot(run, calculatePaidSnapshot(a.chart.id, a.chart.input, accepted.config.editionProfile), accepted.config, () => true);
  return { ...accepted, claimed: run, execution: store.execution(run, accepted.config, new AbortController().signal, () => true) };
}
const permit = { section: "overview" as const, phase: "primary" as const, model: "paid-cheap", reservedMicros: 210000 };
const measured = { basis: "measured" as const, costMicros: 7500, usage: { inputTokens: 100, outputTokens: 100 }, model: "paid-cheap", latencyMs: 1, code: "measured" };

test("settled checkpoint survives crash; replacement worker sends only missing sections and fences stale owner", gated, async () => {
  const a = await account(); const f = fake(); const c = await claimed(a, f);
  const id = await c.execution.admit(permit);
  await c.execution.settle(id, { ...measured, outcome: { kind: "valid", output: { blocks: [{ kind: "prose", text: "Frozen before the crash." }] } } });
  let state = await ledger(c.run.id); assert.equal(state.checkpoints.length, 1); assert.equal(state.run.completedSections, 1);
  await db.update(runs).set({ leaseExpiresAt: new Date(0) }).where(eq(runs.id, c.run.id));
  const finished = await workOnePaidReading({ store, config: f.config });
  assert.equal(finished?.status, "completed"); assert.equal(f.payloads.length, 8);
  state = await ledger(c.run.id); assert.equal(state.editions[0].document.sections[0].blocks[0].kind, "prose");
  assert.equal(JSON.stringify(state.editions[0].document.sections[0].blocks).includes("Frozen before the crash."), true);
  await assert.rejects(() => c.execution.admit({ ...permit, section: "sun" }), /paid_owner_lost/);
  assert.equal((await store.finish(c.claimed, c.config, () => true)).editionId, finished?.editionId, "publication readback is idempotent");
  assert.equal((await ledger(c.run.id)).editions.length, 1);
});

test("lease loss before any permit recovers safely; stale snapshot writer cannot overwrite", gated, async () => {
  const a = await account(); const f = fake(); const c = await claimed(a, f);
  await db.update(runs).set({ leaseExpiresAt: new Date(0) }).where(eq(runs.id, c.run.id));
  const next = await store.claimNext(c.config, () => true); assert.ok(next); assert.notEqual(next.owner, c.claimed.owner);
  await assert.rejects(() => store.saveSnapshot(c.claimed, calculatePaidSnapshot(a.chart.id, input), c.config, () => true), /paid_owner_lost/);
  const finished = await executePaidRun(next, store, c.config, () => true); assert.equal(finished?.status, "completed"); assert.equal(f.payloads.length, 9);
});

test("a committed uncertain slot is never replayed, even after lease expiry, chart deletion or a new period", gated, async () => {
  const a = await account(); const f = fake(); const c = await claimed(a, f);
  await c.execution.admit(permit);
  await db.update(runs).set({ leaseExpiresAt: new Date(0) }).where(eq(runs.id, c.run.id));
  assert.equal(await workOnePaidReading({ store, config: f.config }), null);
  let state = await ledger(c.run.id); assert.equal(state.run.status, "attention"); assert.equal(state.attempts[0].state, "reserved");
  assert.equal(state.attempts[0].reservedMicros, 210000); assert.equal(f.payloads.length, 0);
  await free.deleteReading(a.user.id, a.chart.id);
  const [another] = await db.insert(readings).values({ userId: a.user.id, year: input.year, input, result: calculateSolarReturn(input) }).returning();
  // Synthetic time travel: place the already-consumed allowance in a past month.
  await db.update(allowances).set({ period: "2000-01" }).where(eq(allowances.runId, c.run.id));
  const offer = await store.offer(a.user.id, another.id, "en", c.config, true);
  assert.equal(offer.allowance, "attention");
  const denied = await handlePaidReading(req("POST", { ...c.intent, requestId: randomUUID(), period: offer.period, offerHash: offer.offerHash }), another.id, c.deps);
  assert.equal(denied.status, 409); assert.equal((await denied.json()).code, "paid_run_blocked");
  state = await ledger(c.run.id); assert.equal(state.run.readingId, null); assert.equal(state.attempts.length, 1); assert.equal(state.checkpoints.length, 0); assert.equal(state.snapshot.length, 0);
});

test("unknown usage preserves full exposure; alias mismatch, HTTP failure and transport error cannot look free", gated, async () => {
  for (const failure of ["usage", "alias", "throw"] as const) {
    const a = await account();
    const f = fake((_n, wire) => { if (failure === "throw") throw new Error("RAW_VENDOR_SECRET_SENTINEL"); return response(failure === "alias" ? "paid-strong" : String(wire.model), failure === "usage" ? { usage: null } : {}); });
    const c = await accept(a, f); const finished = await workOnePaidReading({ store, config: f.config });
    assert.equal(finished?.status, "attention"); assert.equal(f.payloads.length, 1);
    const state = await ledger(c.run.id); assert.equal(state.attempts[0].state, "unknown"); assert.equal(state.attempts[0].costMicros, 210000); assert.ok(state.run.consumedAt);
    assert.equal(state.editions.length, 0); assert.equal(JSON.stringify(state.attempts).includes("RAW_VENDOR_SECRET_SENTINEL"), false);
  }
});

test("measured error spend produces an honest partial edition; actual over-ceiling usage is not clamped", gated, async () => {
  const a = await account(); const f = fake((n, wire) => n === 2 ? response(String(wire.model), { error: { message: "PRIVATE_UPSTREAM_FAILURE" } }) : response(String(wire.model)));
  const c = await accept(a, f); const finished = await workOnePaidReading({ store, config: f.config });
  assert.equal(finished?.status, "partial"); assert.equal(f.payloads.length, 2);
  const state = await ledger(c.run.id); assert.equal(state.attempts.reduce((sum, row) => sum + row.costMicros!, 0), 15000);
  assert.equal(state.editions[0].document.accounting?.measuredMxn, 0.015); assert.equal(state.editions[0].document.sections.filter(section => section.status === "generated").length, 1);
  const b = await account(); const big = fake((_n, wire) => response(String(wire.model), { usage: { prompt_tokens: 800000, completion_tokens: 0 } }));
  const d = await accept(b, big); await workOnePaidReading({ store, config: big.config });
  const over = await ledger(d.run.id); assert.equal(over.run.status, "attention"); assert.equal(over.attempts[0].costMicros, 12_000_000); assert.equal(over.editions.length, 0); assert.equal(big.payloads.length, 1);
});

test("primary and single repair settle atomically; no third repair and failed section remains partial", gated, async () => {
  const a = await account(); const f = fake((n, wire) => response(String(wire.model), n <= 2 ? { choices: [{ message: { content: JSON.stringify({ RAW_REPAIR_SECRET: "invalid" }) } }] } : {}));
  const c = await accept(a, f); const finished = await workOnePaidReading({ store, config: f.config });
  assert.equal(finished?.status, "partial"); assert.equal(f.payloads.length, 10);
  const state = await ledger(c.run.id); assert.equal(state.attempts.filter(row => row.section === "overview").length, 2);
  assert.equal(state.editions[0].document.sections[0].status, "failed"); assert.equal(state.editions[0].document.accounting?.measuredMxn, 0.0825);
  assert.equal(JSON.stringify(f.payloads).includes("RAW_REPAIR_SECRET"), false); assert.equal(state.checkpoints.length, 0);
  assert.equal(await workOnePaidReading({ store, config: f.config }), null); assert.equal(f.payloads.length, 10);
});

test("repair itself requires current consent and shared revision; kill and re-enable cannot revive an old grant", gated, async () => {
  const a = await account(); const f = fake(async (_n, wire) => { await store.setEnabled(false); await store.setEnabled(true); return response(String(wire.model), { choices: [{ message: { content: "{}" } }] }); });
  const c = await accept(a, f); const finished = await workOnePaidReading({ store, config: f.config });
  assert.equal(finished?.status, "failed"); assert.equal(finished?.reason, "paid_disabled"); assert.equal(f.payloads.length, 1);
  const state = await ledger(c.run.id); assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0].state, "measured"); assert.equal(state.editions.length, 0); assert.equal(state.checkpoints.length, 0);
});

test("withdrawal during HTTP records cost but forbids repair/publication; re-grant does not restore the allowance", gated, async () => {
  const a = await account(); const f = fake(async (_n, wire) => { await free.withdraw(a.user.id, "en"); return response(String(wire.model), { choices: [{ message: { content: "{}" } }] }); });
  const c = await accept(a, f); const finished = await workOnePaidReading({ store, config: f.config });
  assert.equal(finished?.status, "failed"); assert.equal(f.payloads.length, 1);
  const state = await ledger(c.run.id); assert.equal(state.editions.length, 0); assert.equal(state.attempts[0].state, "measured"); assert.equal(state.checkpoints.length, 0);
  await free.grant(a.user.id, processorProfile()!, 2, "es");
  const answer = await handlePaidReading(req("POST", { ...c.intent, requestId: randomUUID() }), a.chart.id, c.deps);
  assert.equal(answer.status, 409); assert.equal((await answer.json()).code, "paid_allowance_used");
});

test("entitlement is checked before paid calculation and each dispatch; expiry can finalize recorded sections", gated, async () => {
  const a = await account(); const f = fake(); const c = await accept(a, f);
  await db.update(subscriptions).set({ currentPeriodEnd: new Date(0) }).where(eq(subscriptions.userId, a.user.id));
  await workOnePaidReading({ store, config: f.config });
  let state = await ledger(c.run.id); assert.equal(state.run.failureCode, "paid_entitlement_required"); assert.equal(state.attempts.length, 0); assert.equal(state.snapshot.length, 0); assert.equal(state.run.consumedAt, null);
  const b = await account(); const expiring = fake(async (_n, wire) => { await db.update(subscriptions).set({ currentPeriodEnd: new Date(0) }).where(eq(subscriptions.userId, b.user.id)); return response(String(wire.model)); });
  const d = await accept(b, expiring); const finished = await workOnePaidReading({ store, config: expiring.config });
  assert.equal(finished?.status, "partial"); assert.equal(expiring.payloads.length, 1);
  state = await ledger(d.run.id); assert.equal(state.editions.length, 1); assert.equal(state.run.completedSections, 1);
});

test("cancel-at-period-end stays entitled; canceled, past-due, non-granting and expired do not", gated, async () => {
  const f = fake(); const config = await ready(f.config());
  for (const status of ["active", "trialing", "canceled", "past_due", "unpaid", "paused"]) {
    const a = await account({ status });
    await db.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.userId, a.user.id));
    const offered = await store.offer(a.user.id, a.chart.id, "en", config, true);
    assert.equal(offered.entitled, status === "active" || status === "trialing");
    await db.update(subscriptions).set({ grantsAccess: false }).where(eq(subscriptions.userId, a.user.id));
    assert.equal((await store.offer(a.user.id, a.chart.id, "en", config, true)).entitled, false);
  }
});

test("explicit pre-permit stop releases reservation; in-flight stop retains usage and never publishes", gated, async () => {
  const a = await account(); const f = fake(); const c = await accept(a, f);
  assert.equal((await handlePaidStop(req("POST", {}), a.chart.id, c.run.id, c.deps)).status, 200);
  let state = await ledger(c.run.id); assert.equal(state.run.status, "stopped"); assert.equal(state.run.consumedAt, null);
  assert.equal((await db.select().from(allowances).where(eq(allowances.runId, c.run.id))).length, 0);
  assert.equal(await workOnePaidReading({ store, config: f.config }), null);
  const b = await account(); const entered = barrier(); const resume = barrier(); const slow = fake(async (_n, wire) => { entered.release(); await resume.wait; return response(String(wire.model)); });
  const d = await accept(b, slow); const pending = workOnePaidReading({ store, config: slow.config });
  await entered.wait;
  try { assert.equal((await handlePaidStop(req("POST", {}), b.chart.id, d.run.id, d.deps)).status, 200); }
  finally { resume.release(); }
  assert.equal((await pending)?.status, "stopped"); state = await ledger(d.run.id);
  assert.equal(state.attempts[0].state, "measured"); assert.ok(state.run.consumedAt); assert.equal(state.editions.length, 0); assert.equal(state.checkpoints.length, 0); assert.equal(slow.payloads.length, 1);
});

test("chart deletion erases private checkpoints/snapshot but keeps the consumed accounting", gated, async () => {
  const a = await account(); const entered = barrier(); const resume = barrier(); const f = fake(async (_n, wire) => { entered.release(); await resume.wait; return response(String(wire.model)); });
  const c = await accept(a, f); const pending = workOnePaidReading({ store, config: f.config });
  await entered.wait;
  try { await free.deleteReading(a.user.id, a.chart.id); } finally { resume.release(); }
  await pending;
  const state = await ledger(c.run.id); assert.equal(state.run.readingId, null); assert.ok(state.run.consumedAt); assert.equal(state.attempts[0].state, "measured");
  assert.equal(state.editions.length, 0); assert.equal(state.snapshot.length, 0); assert.equal(state.checkpoints.length, 0); assert.equal(f.payloads.length, 1);
  assert.equal((await db.select().from(allowances).where(eq(allowances.runId, c.run.id))).length, 1);
});

test("account deletion cascades paid state; late provider result cannot recreate private data or ledger", gated, async () => {
  const a = await account(); const entered = barrier(); const resume = barrier(); const f = fake(async (_n, wire) => { entered.release(); await resume.wait; return response(String(wire.model)); });
  const c = await accept(a, f); const pending = workOnePaidReading({ store, config: f.config });
  await entered.wait;
  try { await db.delete(users).where(eq(users.id, a.user.id)); } finally { resume.release(); }
  await pending; const state = await ledger(c.run.id);
  assert.equal(state.run, undefined); assert.equal(state.attempts.length, 0); assert.equal(state.snapshot.length, 0); assert.equal(state.checkpoints.length, 0); assert.equal(state.editions.length, 0);
});

test("queued deadline and month rollover release only pre-permit reservations; GET never performs recovery", gated, async () => {
  const a = await account(); const f = fake(); const c = await accept(a, f);
  await db.update(runs).set({ queueExpiresAt: new Date(0) }).where(eq(runs.id, c.run.id));
  const before = JSON.stringify(await ledger(c.run.id));
  assert.equal((await handlePaidReading(req("GET"), a.chart.id, c.deps)).status, 200);
  assert.equal(JSON.stringify(await ledger(c.run.id)), before);
  await workOnePaidReading({ store, config: f.config, enabled: () => false });
  assert.equal((await ledger(c.run.id)).run.status, "failed");
  assert.equal((await db.select().from(allowances).where(eq(allowances.runId, c.run.id))).length, 0);
  const b = await account(); const d = await accept(b, f);
  await db.update(runs).set({ period: "2000-01" }).where(eq(runs.id, d.run.id));
  await workOnePaidReading({ store, config: f.config });
  assert.equal((await ledger(d.run.id)).run.failureCode, "paid_period_changed"); assert.equal(f.payloads.length, 0);
});

test("editorial approval and a live executor are mandatory and version/locale bound", gated, async () => {
  const a = await account(); const f = fake(); const config = f.config()!;
  await store.announceWorker(config); await free.grant(a.user.id, processorProfile()!, 0, "en");
  let offer = await store.offer(a.user.id, a.chart.id, "en", config, true); assert.equal(offer.available, false);
  await ready(config); await db.update(approvals).set({ revokedAt: new Date() }).where(and(eq(approvals.configHash, config.fingerprint), eq(approvals.locale, "es")));
  offer = await store.offer(a.user.id, a.chart.id, "en", config, true); assert.equal(offer.available, true);
  assert.equal((await store.offer(a.user.id, a.chart.id, "es", config, true)).available, false);
  await db.update(controls).set({ workerHeartbeatAt: new Date(0) }).where(eq(controls.id, "paid"));
  assert.equal((await store.offer(a.user.id, a.chart.id, "en", config, true)).available, false);
  const denied = await handlePaidReading(req("POST", { requestId: randomUUID(), profile: PAID_PROFILE, locale: "en", period: offer.period, offerHash: offer.offerHash }), a.chart.id, options(a, f));
  assert.equal(denied.status, 503); assert.equal(f.payloads.length, 0);
});

test("provider HTTP holds no DB connection; another connection cannot claim the live paid lease", gated, async () => {
  const a = await account(); const entered = barrier(); const resume = barrier(); const f = fake(async (n, wire) => { if (n === 1) { entered.release(); await resume.wait; } return response(String(wire.model)); });
  const c = await accept(a, f);
  const secondPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, allowExitOnIdle: true });
  const database = drizzle(secondPool);
  const second = new PaidReadingStore(database, (userId, fn) => withAccountLifecycleLock(userId, fn, { pool: secondPool, db: database }));
  const pending = workOnePaidReading({ store: second, config: f.config });
  try {
    await entered.wait;
    assert.equal(await store.claimNext(c.config, () => true), null);
    const probe = await Promise.race([secondPool.query("select 1 as usable"), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("DB connection held over HTTP")), 1000); timer.unref(); })]);
    assert.equal(probe.rows[0].usable, 1);
    const repeated = await handlePaidReading(req("POST", c.intent), a.chart.id, c.deps); assert.equal(repeated.status, 202);
  } finally { resume.release(); }
  try { assert.equal((await pending)?.status, "completed"); assert.equal(f.payloads.length, 9); }
  finally { await secondPool.end(); }
});

test("ledger validates model receipts, enforces one outstanding attempt and never releases a consumed zero-cost permit", gated, async () => {
  const a = await account(); const f = fake(); const c = await claimed(a, f);
  await assert.rejects(() => c.execution.admit({ ...permit, section: "guidance" }), /paid_permit_invalid/);
  await assert.rejects(() => c.execution.admit({ ...permit, reservedMicros: 1 }), /paid_permit_invalid/);
  await assert.rejects(() => c.execution.admit({ ...permit, phase: "repair" }), /paid_repair_not_authorized/);
  const id = await c.execution.admit(permit);
  await assert.rejects(() => c.execution.admit({ ...permit, section: "sun" }), /paid_uncertain_attempt/);
  await assert.rejects(() => c.execution.settle(id, { ...measured, model: "paid-strong", costMicros: 15000 }), /accounting_invalid/);
  assert.equal((await ledger(c.run.id)).attempts[0].state, "reserved");
  assert.equal(await c.execution.settle(id, { basis: "not_dispatched", costMicros: 0, model: null, usage: null, latencyMs: 0, code: "generation_cancelled" }), 0);
  assert.equal(await c.execution.settle(id, measured), 0, "duplicate settlement cannot replace the first receipt");
  await store.fail(c.claimed, "paid_stopped");
  const allowance = await db.select().from(allowances).where(eq(allowances.runId, c.run.id)); assert.ok(allowance[0]?.consumedAt);
  await assert.rejects(() => db.insert(attempts).values({ runId: c.run.id, owner: c.claimed.owner!, ...permit, requestedModel: permit.model, reservedMicros: permit.reservedMicros }), error => (error as { cause?: { code?: string } }).cause?.code === "23505");
});

test("translation is explicit and separately funded; two monthly editions can share a real contentVersion without overwrite", gated, async () => {
  const a = await account(); const f = fake(); const c = await accept(a, f); const first = await workOnePaidReading({ store, config: f.config }); assert.ok(first?.editionId);
  let offer = await store.offer(a.user.id, a.chart.id, "es", c.config, true);
  let intent = { requestId: randomUUID(), locale: "es", profile: PAID_PROFILE, period: offer.period, offerHash: offer.offerHash };
  assert.equal((await handlePaidReading(req("POST", intent), a.chart.id, c.deps)).status, 409);
  // Simulate the prior edition having been funded in the previous UTC month.
  await db.update(allowances).set({ period: "2000-01" }).where(eq(allowances.runId, c.run.id));
  await db.update(runs).set({ period: "2000-01" }).where(eq(runs.id, c.run.id));
  offer = await store.offer(a.user.id, a.chart.id, "es", c.config, true);
  intent = { ...intent, requestId: randomUUID(), period: offer.period, offerHash: offer.offerHash };
  assert.equal((await handlePaidReading(req("POST", intent), a.chart.id, c.deps)).status, 202);
  assert.equal(f.payloads.length, 9, "acceptance alone does no provider work");
  const second = await workOnePaidReading({ store, config: f.config }); assert.ok(second?.editionId); assert.notEqual(second.editionId, first.editionId);
  const saved = await db.select().from(editions).where(eq(editions.readingId, a.chart.id)); assert.equal(saved.length, 2);
  assert.equal(saved[0].contentVersion, saved[1].contentVersion, "no fake version bump to bypass document uniqueness");
  assert.equal((await loadReadingPresentation(a.viewer, a.chart.id, "es", { kind: "paid", id: first.editionId })).content.locale, "en");
  assert.equal((await loadReadingPresentation(a.viewer, a.chart.id, "en", { kind: "paid", id: second.editionId })).content.locale, "es");
});

test("stored edition display never reuses a changed chart; snapshot contradictions are rejected", gated, async () => {
  const a = await account(); const f = fake(); const c = await accept(a, f); const finished = await workOnePaidReading({ store, config: f.config }); assert.ok(finished?.editionId);
  const before = await loadReadingPresentation(a.viewer, a.chart.id, "en", { kind: "paid", id: finished.editionId });
  await db.update(readings).set({ input: { ...input, name: "CHANGED_DISPLAY_NAME" }, result: { ...a.chart.result, sunHouse: 12 } }).where(eq(readings.id, a.chart.id));
  assert.deepEqual(await loadReadingPresentation(a.viewer, a.chart.id, "en", { kind: "paid", id: finished.editionId }), before);
  const snapshot = structuredClone((await ledger(c.run.id)).editions[0].snapshot);
  snapshot.chart.result.sunHouse = snapshot.chart.result.sunHouse === 1 ? 2 : 1;
  assert.throws(() => readPaidSnapshot(snapshot), /snapshot_invalid/);
});

test("explicit stop signals in-flight transport through heartbeat; abort is uncertain spend, not an automatic refund", gated, async () => {
  process.env.READINGS_REQUEST_TIMEOUT_MS = "15000";
  const a = await account(); const entered = barrier(); const aborted = barrier();
  const f = fake((_n, _wire, signal) => new Promise<Response>((_resolve, reject) => {
    entered.release(); signal?.addEventListener("abort", () => { aborted.release(); reject(new Error("synthetic transport abort")); }, { once: true });
  }));
  const c = await accept(a, f); const pending = workOnePaidReading({ store, config: f.config });
  await entered.wait;
  await handlePaidStop(req("POST", {}), a.chart.id, c.run.id, c.deps);
  await aborted.wait; const finished = await pending;
  assert.equal(finished?.status, "stopped"); assert.equal(f.payloads.length, 1);
  const state = await ledger(c.run.id); assert.equal(state.attempts[0].state, "unknown"); assert.equal(state.attempts[0].costMicros, state.attempts[0].reservedMicros);
  assert.equal((await store.offer(a.user.id, a.chart.id, "en", c.config, true)).allowance, "attention");
});

test("recovered measured checkpoints may finalize after entitlement expiry but may not dispatch again", gated, async () => {
  const a = await account(); const f = fake(); const c = await claimed(a, f);
  const id = await c.execution.admit(permit);
  await c.execution.settle(id, { ...measured, outcome: { kind: "valid", output: { blocks: [{ kind: "prose", text: "Authorized before expiry." }] } } });
  await db.update(subscriptions).set({ status: "canceled" }).where(eq(subscriptions.userId, a.user.id));
  await db.update(runs).set({ leaseExpiresAt: new Date(0) }).where(eq(runs.id, c.run.id));
  const result = await workOnePaidReading({ store, config: f.config });
  assert.equal(result?.status, "partial"); assert.equal(f.payloads.length, 0); assert.equal((await ledger(c.run.id)).editions.length, 1);
});

test("real webhook subscription update honors user fence before changing entitlement (no generation side effect)", gated, async () => {
  const { processStripeEvent } = await import("../src/lib/stripe-sync");
  const { stripeEvents, auditLogs } = await import("../src/db/schema");
  const a = await account(); const f = fake(); const c = await claimed(a, f);
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.userId, a.user.id));
  await db.update(users).set({ stripeCustomerId: subscription.stripeCustomerId }).where(eq(users.id, a.user.id));
  const eventId = `evt_${randomUUID()}`;
  const oldPrice = process.env.STRIPE_PRICE_ID_MXN; process.env.STRIPE_PRICE_ID_MXN = subscription.stripePriceId;
  const client = await pool.connect(); let processing: Promise<unknown> | undefined;
  try {
    await client.query("begin");
    // FK KEY SHARE would not conflict with this lock. Only the explicit user
    // update fence can make this existing-subscription webhook wait here.
    await client.query("select id from users where id=$1 for no key update", [a.user.id]);
    let settled = false;
    processing = processStripeEvent({ id: eventId, type: "customer.subscription.updated", data: { object: { id: subscription.stripeSubscriptionId } } } as never, {
      subscriptions: { retrieve: async () => ({ id: subscription.stripeSubscriptionId, customer: subscription.stripeCustomerId,
        metadata: { solara_user_id: a.user.id, solara_product: "premium" }, status: "canceled", cancel_at_period_end: false,
        items: { data: [{ price: { id: subscription.stripePriceId, currency: "mxn" }, current_period_end: Math.floor(Date.now() / 1000) + 3600 }] } }) },
    } as never).finally(() => { settled = true; });
    let fenced = false;
    for (let i = 0; i < 100 && !settled; i++) {
      const waiting = await pool.query("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from \"users\"%for update%') as fenced");
      if (waiting.rows[0].fenced) { fenced = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fenced, true, "webhook must take the user fence even when the customer is already linked");
    assert.equal((await db.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, subscription.stripeSubscriptionId)))[0].status, "active");
    await client.query("commit"); await processing;
    await assert.rejects(() => c.execution.admit(permit), /paid_entitlement_required/); assert.equal(f.payloads.length, 0);
  } finally {
    await client.query("rollback"); client.release();
    if (processing) await processing;
    if (oldPrice === undefined) delete process.env.STRIPE_PRICE_ID_MXN; else process.env.STRIPE_PRICE_ID_MXN = oldPrice;
    await db.delete(stripeEvents).where(eq(stripeEvents.id, eventId)); await db.delete(auditLogs).where(eq(auditLogs.target, subscription.stripeSubscriptionId));
  }
});

test("rich paid profile publishes eleven sections with frozen natal/profection/transit facts without relabeling an earlier core edition", gated, async () => {
  const coreOwner = await account(); const coreFake = fake(); await accept(coreOwner, coreFake);
  const core = await workOnePaidReading({ store, config: coreFake.config }); assert.ok(core?.editionId);
  const coreView = await loadReadingPresentation(coreOwner.viewer, coreOwner.chart.id, "en", { kind: "paid", id: core.editionId });
  process.env.READINGS_PAID_PROFILE = PAID_RICH_PROFILE;
  const a = await account(); const f = fake(); const accepted = await accept(a, f, "es");
  assert.equal(accepted.offer.profile, PAID_RICH_PROFILE); assert.equal(accepted.run.totalSections, 11);
  const result = await workOnePaidReading({ store, config: f.config }); assert.equal(result?.status, "completed"); assert.ok(result?.editionId);
  assert.equal(f.payloads.length, 11); assert.equal(result.completedSections, 11);
  const saved = await ledger(accepted.run.id); const edition = saved.editions[0];
  assert.equal(edition.profile, PAID_RICH_PROFILE); assert.deepEqual(edition.expectedSections, [...PAID_RICH_SECTIONS]);
  assert.deepEqual(edition.document.sections.map(section => section.key), [...PAID_RICH_SECTIONS]);
  assert.equal(edition.snapshot.profile, PAID_RICH_PROFILE);
  if (edition.snapshot.profile !== PAID_RICH_PROFILE) throw Error("rich snapshot missing");
  assert.equal(edition.snapshot.annual.referenceAt, edition.snapshot.chart.result.exactUtc);
  assert.equal(edition.snapshot.annual.profections.age, 42);
  const wire = JSON.stringify(f.payloads); assert.match(wire, /traditional-whole-sign-selected-year-v1/); assert.match(wire, /solar-return-instant-transits-v1/);
  for (const secret of [a.user.email, input.name, input.birthDate, input.birthPlace.name, edition.snapshot.annual.referenceAt, "referenceAt"]) assert.equal(wire.includes(secret), false, secret);
  assert.deepEqual(await loadReadingPresentation(coreOwner.viewer, coreOwner.chart.id, "en", { kind: "paid", id: core.editionId }), coreView);
  const offered = await store.offer(coreOwner.user.id, coreOwner.chart.id, "es", f.config(), true);
  assert.equal(offered.runs[0].profile, PAID_PROFILE); assert.equal(offered.runs[0].totalSections, 9, "history carries its own manifest");
  assert.equal((await db.select().from(freeRuns).where(eq(freeRuns.userId, a.user.id))).length, 0);
  // Database contract cannot relabel a nine-section run as the rich profile.
  await assert.rejects(db.update(runs).set({ profile: PAID_RICH_PROFILE }).where(eq(runs.id, core.id)), error => (error as { cause?: { code?: string } }).cause?.code === "23514");
});

test("rich paid profile cannot reuse narrower consent or core editorial approval", gated, async () => {
  const a = await account(); const f = fake(); const coreConfig = await ready(f.config());
  await free.grant(a.user.id, processorProfile()!, 0, "en");
  process.env.READINGS_PAID_PROFILE = PAID_RICH_PROFILE;
  const richConfig = f.config()!; assert.ok(richConfig); assert.notEqual(coreConfig.fingerprint, richConfig.fingerprint); assert.notEqual(coreConfig.contentVersion, richConfig.contentVersion);
  await store.announceWorker(richConfig);
  assert.equal((await store.offer(a.user.id, a.chart.id, "en", richConfig, true)).available, false, "core approval is not transferable");
  await ready(richConfig);
  const offer = await store.offer(a.user.id, a.chart.id, "en", richConfig, true);
  const intent = { requestId: randomUUID(), locale: "en", profile: PAID_RICH_PROFILE, period: offer.period, offerHash: offer.offerHash };
  const denied = await handlePaidReading(req("POST", intent), a.chart.id, options(a, f)); assert.equal(denied.status, 409); assert.equal((await denied.json()).code, "consent_required");
  assert.equal((await db.select().from(allowances).where(eq(allowances.userId, a.user.id))).length, 0);
  await free.grant(a.user.id, processorProfile()!, 1, "en");
  assert.equal((await handlePaidReading(req("POST", intent), a.chart.id, options(a, f))).status, 202); assert.equal(f.payloads.length, 0);
});

test("rich paid high-latitude natal angles produce an explicit profection limitation, not a return-Ascendant substitution", gated, async () => {
  process.env.READINGS_PAID_PROFILE = PAID_RICH_PROFILE;
  const a = await account({ input: { ...input, birthPlace: { name: "Synthetic polar natal", latitude: 69.65, longitude: 18.96, timezone: "Europe/Oslo" } } });
  const f = fake(); const accepted = await accept(a, f); const result = await workOnePaidReading({ store, config: f.config });
  assert.equal(result?.status, "completed"); assert.equal(f.payloads.length, 11);
  const snapshot = (await ledger(accepted.run.id)).editions[0].snapshot; assert.ok(snapshot.profile === PAID_RICH_PROFILE);
  assert.equal(snapshot.annual.profections.status, "unavailable"); assert.equal(snapshot.facts.natal.angles.ascendant, null); assert.ok(snapshot.facts.angles.ascendant);
  assert.ok(JSON.stringify(f.payloads[8]).includes("natal_ascendant_unavailable"));
  assert.equal(snapshot.annual.transits.aspects.some(a => a.natal === "Ascendant"), false);
});

test("rich paid worst-case preflight includes two extra primaries and repairs, while core and free configuration remain valid", gated, async () => {
  process.env.READINGS_MODEL_PRICES = JSON.stringify(Object.fromEntries(Object.entries(prices).map(([model, price]) => [model, { inputMxnPerMillion: price.inputMxnPerMillion * 2, outputMxnPerMillion: price.outputMxnPerMillion * 2 }])));
  const f = fake(); assert.ok(f.config());
  process.env.READINGS_PAID_PROFILE = PAID_RICH_PROFILE;
  // Compare a primitive: Node's test reporter cannot serialize a failed
  // assertion's config object (provider functions) without losing ERR_ASSERTION.
  assert.equal(f.config() === null, true, "22 worst-case calls exceed 10 MXN while 18 still fit"); assert.ok(liveGenerationConfig(f.transport));
  process.env.READINGS_PAID_PROFILE = "unknown-profile";
  assert.equal(f.config(), null); assert.ok(liveGenerationConfig(f.transport));
});

test("content-version changes fence a warm worker before repair even when model/pricing fingerprint stays unchanged", gated, async () => {
  let changed = false;
  const a = await account();
  const f = fake((_call, wire) => { changed = true; return response(String(wire.model), { choices: [{ message: { content: "{}" } }] }); });
  const originalConfig = f.config;
  f.config = () => { const config = originalConfig(); return config && changed ? { ...config, contentVersion: "changed-editorial-contract" } : config; };
  const accepted = await accept(a, f);
  await workOnePaidReading({ store, config: f.config });
  const saved = await ledger(accepted.run.id);
  assert.equal(f.payloads.length, 1, "an old editorial approval cannot authorize a new-contract repair");
  assert.equal(saved.run.failureCode, "paid_disabled"); assert.equal(saved.run.status, "failed");
  assert.ok(saved.run.consumedAt); assert.equal(saved.attempts[0].state, "measured");
  assert.equal(saved.editions.length, 0); assert.equal(saved.checkpoints.length, 0);
});

test("a settled invalid checkpoint does not bypass fresh consent, entitlement, stop or lease checks for repair", gated, async () => {
  for (const reason of ["consent_required", "paid_entitlement_required", "paid_stopped", "paid_deadline"] as const) {
    const a = await account(); const f = fake(); const c = await claimed(a, f);
    const id = await c.execution.admit(permit);
    await c.execution.settle(id, { ...measured, outcome: { kind: "invalid" } });
    assert.equal((await ledger(c.run.id)).checkpoints[0].kind, "invalid");
    if (reason === "consent_required") await free.withdraw(a.user.id, "en");
    else if (reason === "paid_entitlement_required") await db.update(subscriptions).set({ grantsAccess: false }).where(eq(subscriptions.userId, a.user.id));
    else if (reason === "paid_stopped") await store.stop(a.user.id, a.chart.id, c.run.id);
    else await db.update(runs).set({ leaseExpiresAt: new Date(0) }).where(eq(runs.id, c.run.id));
    await assert.rejects(() => c.execution.admit({ ...permit, phase: "repair" }), new RegExp(reason));
    assert.equal((await ledger(c.run.id)).attempts.length, 1); assert.equal(f.payloads.length, 0);
  }
});

test("paid read rejects an otherwise valid frozen snapshot with a mismatching hash and unpublished or mismatched run provenance", gated, async () => {
  const a = await account(); const f = fake(); await accept(a, f);
  const finished = await workOnePaidReading({ store, config: f.config }); assert.ok(finished?.editionId);
  const base = new ReadingViewStore(); const original = await base.paidSnapshot(a.user.id, a.chart.id, finished.editionId); assert.ok(original);
  const mutations: ((row: NonNullable<typeof original>) => void)[] = [
    row => { (row.edition.snapshot as ReturnType<typeof readPaidSnapshot>).chart.name = "Changed without republishing"; },
    row => { row.run.status = "generating"; },
    row => { row.run.consumedAt = null; },
    row => { row.run.locale = "es"; },
    row => { row.run.expectedSections = ["overview", "sun"]; },
    row => { row.edition.contentVersion = "other-version"; },
    row => { const document = JSON.parse(row.edition.serialized!); document.edition.snapshotHash = "a".repeat(64); row.edition.serialized = JSON.stringify(document); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original); mutate(changed);
    const source = new ReadingViewStore(); source.paidSnapshot = async () => changed;
    await assert.rejects(() => loadReadingPresentation(a.viewer, a.chart.id, "en", { kind: "paid", id: finished.editionId! }, { store: source }), /document_unavailable/);
  }
});

for (const phase of ["primary", "repair"] as const) for (const failure of ["provider_error", "missing_checkpoint", "not_dispatched"] as const) {
  test(`recovery never spends after settled ${phase} ${failure}, with or without prior output`, gated, async () => {
    for (const priorOutput of [false, true]) {
      const a = await account();
      const f = fake((_call, wire) => response(String(wire.model), { error: { message: "PRIVATE_CRASH_PROVIDER_ERROR" } }));
      const c = await claimed(a, f);
      if (priorOutput) {
        const good = await c.execution.admit(permit);
        await c.execution.settle(good, { ...measured, outcome: { kind: "valid", output } });
      }
      const section = priorOutput ? "sun" : "overview";
      if (phase === "repair") {
        const primary = await c.execution.admit({ ...permit, section });
        await c.execution.settle(primary, { ...measured, outcome: { kind: "invalid" } });
      }
      if (failure === "provider_error") {
        const { dispatchAttempt } = await import("../src/readings/execution");
        const { paidDigest } = await import("../src/readings/paid-chart");
        const { sectionJsonSchema, validateSectionOutput } = await import("../src/readings/schemas");
        const frozen = (await ledger(c.run.id)).snapshot[0].snapshot;
        const result = await dispatchAttempt(c.execution, c.config.provider, { section, locale: "en", model: permit.model, maxOutputTokens: 2000,
          prompt: "Synthetic crash-boundary request", digest: paidDigest(readPaidSnapshot(frozen)), jsonSchema: sectionJsonSchema(section, "paid") }, phase,
        value => validateSectionOutput(section, value, "paid"));
        assert.equal(result.halt, "provider_error"); // Simulate death before handling it.
      } else {
        const halted = await c.execution.admit({ ...permit, section, phase });
        await c.execution.settle(halted, failure === "not_dispatched"
          ? { basis: "not_dispatched", costMicros: 0, model: null, usage: null, latencyMs: 0, code: "generation_cancelled" }
          : measured);
      }
      const before = await ledger(c.run.id); const sentBeforeCrash = f.payloads.length;
      assert.equal(JSON.stringify(before).includes("PRIVATE_CRASH_PROVIDER_ERROR"), false, "raw provider errors are not persisted");
      // The receipt committed, but the original process never handled its halt.
      await db.update(runs).set({ leaseExpiresAt: new Date(0) }).where(eq(runs.id, c.run.id));
      const finished = await workOnePaidReading({ store, config: f.config });
      assert.equal(f.payloads.length, sentBeforeCrash, "a recovered halt must never authorize later sections or repairs");
      assert.equal(finished?.status, priorOutput ? "partial" : "failed");
      assert.equal(finished?.reason, priorOutput ? "paid_partial" : "paid_no_output");
      const after = await ledger(c.run.id);
      assert.deepEqual(after.attempts, before.attempts, "all original receipts and spend remain exactly intact");
      assert.equal(after.editions.length, priorOutput ? 1 : 0);
      assert.equal(after.checkpoints.length, 0); assert.equal(after.snapshot.length, 0);
      assert.ok(after.run.consumedAt);
      assert.ok((await db.select().from(allowances).where(eq(allowances.runId, c.run.id)))[0]?.consumedAt);
      if (priorOutput) {
        assert.equal(after.editions[0].document.sections.filter(s => s.status === "generated").length, 1);
        assert.equal(after.editions[0].document.accounting?.measuredMxn, before.attempts.reduce((sum, row) => sum + row.costMicros!, 0) / 1_000_000);
      }
      assert.equal(await workOnePaidReading({ store, config: f.config }), null);
    }
  });
}

test("permit admission independently fences a settled error, missing checkpoint or no-send halt", gated, async () => {
  for (const failure of ["provider_error", "missing_checkpoint", "not_dispatched"] as const) {
    const a = await account(); const f = fake(); const c = await claimed(a, f);
    const id = await c.execution.admit(permit);
    await c.execution.settle(id, failure === "not_dispatched"
      ? { basis: "not_dispatched", costMicros: 0, model: null, usage: null, latencyMs: 0, code: "generation_cancelled" }
      : { ...measured, code: failure === "provider_error" ? failure : "measured" });
    await assert.rejects(() => c.execution.admit({ ...permit, section: "sun" }), /paid_attempt_halted/);
    assert.equal((await ledger(c.run.id)).attempts.length, 1); assert.equal(f.payloads.length, 0);
    await store.fail(c.claimed, "synthetic_cleanup");
  }
});

for (const loss of ["expiry", "revocation", "withdrawal", "owner_loss"] as const) test(`in-flight heartbeat: ${loss} preserves the correct settlement and publication boundary`, { ...gated, timeout: 25000 }, async () => {
  process.env.READINGS_REQUEST_TIMEOUT_MS = "15000";
  const a = await account(); const entered = barrier(); const release = barrier(); const beat = barrier();
  let changed = false; let aborted = false;
  class ObservedStore extends PaidReadingStore {
    override async heartbeat(...args: Parameters<PaidReadingStore["heartbeat"]>) {
      const observe = changed;
      try { await super.heartbeat(...args); }
      // Let the worker's rejection handler signal its transport before the
      // test releases the response; observing only super's finally races it.
      finally { if (observe) setImmediate(beat.release); }
    }
  }
  const observed = new ObservedStore();
  const f = fake(async (call, wire, signal) => {
    if (call === 2) {
      entered.release();
      await new Promise<void>((resolve, reject) => {
        const stop = () => { aborted = true; reject(new Error("synthetic in-flight abort")); };
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
        void release.wait.then(() => { signal?.removeEventListener("abort", stop); resolve(); });
      });
    }
    return response(String(wire.model));
  });
  const c = await accept(a, f); const pending = workOnePaidReading({ store: observed, config: f.config });
  try {
    await entered.wait;
    if (loss === "expiry") await db.update(subscriptions).set({ currentPeriodEnd: new Date(0) }).where(eq(subscriptions.userId, a.user.id));
    if (loss === "revocation") await db.update(subscriptions).set({ status: "canceled", grantsAccess: false }).where(eq(subscriptions.userId, a.user.id));
    if (loss === "withdrawal") await free.withdraw(a.user.id, "en");
    if (loss === "owner_loss") await db.update(runs).set({ owner: randomUUID() }).where(eq(runs.id, c.run.id));
    changed = true;
    // Wait for a REAL five-second lease heartbeat after the change; no timer mock.
    await beat.wait;
  } finally { release.release(); }
  const finished = await pending; const state = await ledger(c.run.id);
  const entitlementOnly = loss === "expiry" || loss === "revocation";
  assert.equal(aborted, !entitlementOnly, "only non-entitlement fences abort an authorized in-flight transport");
  assert.equal(f.payloads.length, 2, "never send a third section after the loss");
  assert.equal(state.attempts.length, 2); assert.equal(state.attempts.filter(row => row.state === "measured").length, entitlementOnly ? 2 : 1);
  assert.equal(state.attempts.filter(row => row.state === "unknown").length, entitlementOnly ? 0 : 1);
  assert.equal(state.editions.length, entitlementOnly ? 1 : 0); assert.ok(state.run.consumedAt);
  if (!entitlementOnly) {
    const uncertain = state.attempts.find(row => row.state === "unknown")!;
    assert.equal(uncertain.costMicros, uncertain.reservedMicros); assert.equal(state.checkpoints.length, 0);
    return;
  }
  assert.equal(finished?.status, "partial"); assert.ok(finished.editionId);
  assert.equal(state.run.completedSections, 2); assert.equal(state.editions[0].document.accounting?.measuredMxn, 0.015);
  assert.equal(state.editions[0].document.accounting?.uncertainMxn, 0);
  const view = await loadReadingPresentation(a.viewer, a.chart.id, "es", { kind: "paid", id: finished.editionId });
  assert.equal(view.content.kind, "saved-reading"); assert.equal(view.content.locale, "en");
  assert.equal(view.content.sections.filter(section => section.status === "generated").length, 2);
  execFileSync(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "pipe" });
  const renderer = new ReadingPdfRenderer();
  const pdf = await handleReadingPdf(new Request(`https://app.invalid/api/readings/${a.chart.id}/pdf?paidEdition=${finished.editionId}`), a.chart.id, {
    user: async () => a.viewer, locale: "es", throttle: async () => null, renderer: { render: async projected => {
      assert.deepEqual(projected, { chart: view.chart, content: view.content }); return renderer.render(projected);
    } },
  });
  assert.equal(pdf.status, 200);
  const rendered = await inspectPdf(Buffer.from(await pdf.arrayBuffer()));
  assert.equal(rendered.metadata.Language, "en"); assert.equal((rendered.text.match(/A synthetic complete section/g) ?? []).length, 2);
  assert.equal(f.payloads.length, 2);
});

for (const loss of ["expiry", "revocation"] as const) test(`between-call ${loss} blocks both a next primary and a repair without discarding measured receipts`, gated, async () => {
  for (const needsRepair of [false, true]) {
    const a = await account();
    const f = fake(async (_call, wire) => {
      await db.update(subscriptions).set(loss === "expiry" ? { currentPeriodEnd: new Date(0) } : { grantsAccess: false, status: "canceled" }).where(eq(subscriptions.userId, a.user.id));
      return response(String(wire.model), needsRepair ? { choices: [{ message: { content: "{}" } }] } : {});
    });
    const c = await accept(a, f); const finished = await workOnePaidReading({ store, config: f.config });
    assert.equal(finished?.status, needsRepair ? "failed" : "partial"); assert.equal(f.payloads.length, 1);
    const state = await ledger(c.run.id); assert.equal(state.attempts.length, 1); assert.equal(state.attempts[0].state, "measured");
    assert.equal(state.attempts[0].costMicros, 7500); assert.equal(state.editions.length, needsRepair ? 0 : 1);
  }
});

for (const precision of ["microseconds", "equal_timestamp"] as const) test(`paid history ${precision} pagination preserves every owned edition exactly once`, gated, async () => {
  const { syntheticReadingAccount } = await import("./helpers/reading-account");
  const { syntheticPaidEdition } = await import("./helpers/paid-edition");
  const owner = await syntheticReadingAccount("en", "none");
  const otherChart = await db.insert(readings).values({ userId: owner.viewer.id, year: owner.chart.year, input: owner.chart.input, result: owner.chart.result }).returning();
  const outsider = await account(); const f = fake();
  const deps: PaidHttpDeps = { user: async () => owner.viewer, locale: "en", store, config: f.config, throttle: async () => null };
  const editionIds: string[] = [];
  try {
    for (let i = 0; i < 41; i++) {
      const saved = await syntheticPaidEdition(owner, "en"); editionIds.push(saved.document.id);
      // Every timestamp lies in ONE millisecond. Also cover exact equality and
      // the descending UUID tie-breaker with IDs generated independently of time.
      const at = precision === "equal_timestamp" ? "2026-01-01 12:00:00.100100+00" : `2026-01-01 12:00:00.${100900 - i * 10}+00`;
      await db.update(runs).set({ createdAt: sql`${at}::timestamptz` }).where(eq(runs.id, saved.runId));
    }
    const native = await pool.query<{ id: string; edition_id: string }>(`select r.id, e.id as edition_id from paid_reading_runs r
      join paid_reading_editions e on e.run_id = r.id where r.user_id = $1 and r.reading_id = $2 order by r.created_at desc, r.id desc`, [owner.viewer.id, owner.chart.id]);
    const received: PaidRunView[] = []; const sizes: number[] = []; let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const result = await handlePaidReading(req("GET", undefined, cursor ? `?cursor=${cursor}` : ""), owner.chart.id, deps);
      assert.equal(result.status, 200); const offer: PaidOffer = await result.json();
      sizes.push(offer.runs.length); received.push(...offer.runs); cursor = offer.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(sizes, [20, 20, 1]);
    assert.deepEqual(received.map(row => row.id), native.rows.map(row => row.id));
    assert.deepEqual(received.map(row => row.editionId), native.rows.map(row => row.edition_id));
    assert.deepEqual([...new Set(received.map(row => row.editionId))].sort(), editionIds.sort());
    for (const bad of [randomUUID(), native.rows[0].id]) {
      const foreignDeps = { ...deps, user: async () => outsider.viewer };
      assert.equal((await handlePaidReading(req("GET", undefined, `?cursor=${bad}`), outsider.chart.id, foreignDeps)).status, 400);
      assert.equal((await handlePaidReading(req("GET", undefined, `?cursor=${bad}`), otherChart[0].id, deps)).status, 400);
    }
    assert.equal(f.payloads.length, 0);
  } finally { await owner.cleanup(); }
});

test("paid identity readback: another process locale accepts exact approvals and reads the same JSONB edition", gated, async () => {
  const { identityEnvironment } = await import("./helpers/paid-identity");
  Object.assign(process.env, identityEnvironment());
  const a = await account(); const f = fake(); const c = await accept(a, f);
  const finished = await workOnePaidReading({ store, config: f.config }); assert.ok(finished?.editionId);
  const before = await ledger(c.run.id);
  const view = await loadReadingPresentation(a.viewer, a.chart.id, "en", { kind: "paid", id: finished.editionId });
  const probe = `
    const assert = require('node:assert/strict');
    const { paidGenerationConfig } = require('./src/readings/paid-policy.ts');
    const { PaidReadingStore } = require('./src/readings/paid-store.ts');
    const { loadReadingPresentation } = require('./src/readings/reading-view.ts');
    const { pool, coordinationPool } = require('./src/db/index.ts');
    (async () => {
      const config = paidGenerationConfig(() => { throw Error('no transport in reader'); }); assert.ok(config);
      const offer = await new PaidReadingStore().offer(${JSON.stringify(a.user.id)}, ${JSON.stringify(a.chart.id)}, 'en', config, true);
      const view = await loadReadingPresentation({id:${JSON.stringify(a.user.id)},emailVerifiedAt:new Date(),plan:'free'}, ${JSON.stringify(a.chart.id)}, 'en', {kind:'paid',id:${JSON.stringify(finished.editionId)}});
      process.stdout.write(JSON.stringify({config:config.fingerprint,available:offer.available,edition:offer.runs[0].editionId,view}));
    })().finally(() => Promise.all([pool.end(),coordinationPool.end()]));
  `;
  for (const locale of ["en_US.UTF-8", "tr_TR.UTF-8"]) {
    await store.announceWorker(c.config);
    const observed = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--eval", probe], {
      env: { ...process.env, ...identityEnvironment(true), LANG: locale, LC_ALL: locale, DOTENV_CONFIG_PATH: "/dev/null" }, encoding: "utf8", timeout: 20000,
    }));
    assert.equal(observed.config, c.config.fingerprint); assert.equal(observed.available, true, "the exact synthetic editorial approval is recognized");
    assert.equal(observed.edition, finished.editionId); assert.deepEqual(observed.view, view);
  }
  assert.deepEqual(await ledger(c.run.id), before, "cross-locale reads never rewrite identity or provenance");
});

test("legacy snapshot editions keep original hashes and immutable read access without adopting old approvals", gated, async () => {
  const { originalSnapshotHash } = await import("./helpers/paid-identity");
  const { paidContentVersion } = await import("../src/readings/paid-policy");
  const { paidCalculationPolicy } = await import("../src/readings/paid-chart");
  const { PAID_ALLOWANCE_POLICY, PAID_CEILING_MICROS } = await import("../src/readings/paid-contract");
  for (const profile of [PAID_PROFILE, PAID_RICH_PROFILE]) {
    process.env.READINGS_PAID_PROFILE = profile;
    const a = await account(); const f = fake(); const c = await claimed(a, f);
    // Historical v1/v2 hashes were captured before this fix. Recreate only the
    // OLD identity at fixture insertion; never mutate a published edition.
    const currentSnapshot = calculatePaidSnapshot(a.chart.id, a.chart.input, profile);
    const legacy = readPaidSnapshot({ ...currentSnapshot, version: profile === PAID_PROFILE ? "paid-snapshot/1" : "paid-snapshot/2" });
    await db.delete(snapshots).where(eq(snapshots.runId, c.run.id));
    await db.insert(snapshots).values({ runId: c.run.id, readingId: a.chart.id, snapshot: legacy, hash: originalSnapshotHash(legacy) });
    const id = await c.execution.admit(permit); await c.execution.settle(id, { ...measured, outcome: { kind: "valid", output } });
    const finished = await store.finish(c.claimed, c.config, () => true); assert.ok(finished.editionId);
    const state = await ledger(c.run.id); assert.equal(state.editions[0].snapshotHash, originalSnapshotHash(legacy));
    assert.equal(paidSnapshotHash(legacy), originalSnapshotHash(legacy));
    assert.equal((await loadReadingPresentation(a.viewer, a.chart.id, "es", { kind: "paid", id: finished.editionId })).content.kind, "saved-reading");
    assert.deepEqual(await ledger(c.run.id), state);
    // Old/incompatible config signatures are never re-approved just because
    // the immutable snapshot remains readable under its explicit legacy scheme.
    const obsolete = originalSnapshotHash({ base: liveGenerationConfig(f.transport)!.fingerprint,
      profile, sections: c.config.sections, calculation: paidCalculationPolicy(profile), allowance: PAID_ALLOWANCE_POLICY,
      quotes: c.config.quotes, ceiling: PAID_CEILING_MICROS });
    assert.notEqual(obsolete, c.config.fingerprint, "the new hash scheme explicitly invalidates old config bindings");
    await db.delete(approvals).where(eq(approvals.configHash, c.config.fingerprint));
    await db.insert(approvals).values({ profile, configHash: obsolete, contentVersion: paidContentVersion(obsolete, profile), locale: "en",
      sampleCount: 6, reviewer: "Synthetic obsolete signature, NOT approval", evidence: "local compatibility test" });
    approvalHashes.add(obsolete);
    assert.equal((await store.offer(a.user.id, a.chart.id, "en", c.config, true)).available, false);
    assert.equal((await loadReadingPresentation(a.viewer, a.chart.id, "en", { kind: "paid", id: finished.editionId })).content.kind, "saved-reading");
  }
});
