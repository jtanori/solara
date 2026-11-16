import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, beforeEach } from "node:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { db, pool, coordinationPool } from "../src/db";
import { users, readings, readingDocuments, generationCache, readingGenerationConsents as consents, readingGenerationRuns as runs, readingGenerationAttempts as attempts, rateLimits } from "../src/db/schema";
import { keyFor, AUTH_RATE_LIMITS } from "../src/lib/rate-limit";
import { withAccountLifecycleLock } from "../src/lib/account-lifecycle-lock";
import { defaultDeleteUser } from "../src/app/api/profile/route";
import { calculateSolarReturn } from "../src/lib/solar";
import { handleChartSave } from "../src/readings/chart-save";
import { DbSectionCache } from "../src/readings/db-cache";
import { GenerationBlocked } from "../src/readings/execution";
import { GenerationStore } from "../src/readings/generation-store";
import { handleConsent, handleGeneration, handleReadingDelete, type ReadingHttpDeps } from "../src/readings/http";
import { liveGenerationConfig, processorProfile } from "../src/readings/policy";
import type { ChartInput } from "../src/lib/types";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: !enabled ? "requires RUN_INTEGRATION_TESTS=1 and disposable local PostgreSQL" : false };
const envKeys = ["READINGS_GENERATION_ENABLED", "READINGS_PROVIDER", "READINGS_CHEAP_MODEL", "READINGS_STRONG_MODEL", "READINGS_API_BASE_URL", "READINGS_API_KEY", "READINGS_PROCESSOR_PROFILE", "READINGS_MODEL_PRICES", "READINGS_REQUEST_TIMEOUT_MS"];
let savedEnv: Record<string, string | undefined>;
const allocated: string[] = [];
const input: ChartInput = {
  name: "PRIVATE_RAW_NAME_SENTINEL", birthDate: "1984-05-16", birthTime: "01:00", year: 2026,
  birthPlace: { name: "PRIVATE_BIRTHPLACE_SENTINEL", latitude: 32.6393, longitude: -115.4747, timezone: "America/Tijuana" },
  returnPlace: { name: "PRIVATE_RETURNPLACE_SENTINEL", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" },
};
const result = calculateSolarReturn(input);
const profile = { id: "synthetic-processor", name: "Synthetic Processor (tests only)", policyVersion: "test-v1", inputTokenLimits: { "test-model": 6000 }, servedModels: { "test-model": ["test-model"] } };
const store = new GenerationStore();

beforeEach(() => {
  if (!enabled) return;
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname), "disposable local DB only");
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    READINGS_GENERATION_ENABLED: "true", READINGS_PROVIDER: "chat-completions",
    READINGS_CHEAP_MODEL: "test-model", READINGS_STRONG_MODEL: "test-model", READINGS_API_BASE_URL: "https://processor.invalid/v1",
    READINGS_API_KEY: "FAKE_PROVIDER_KEY_SENTINEL", READINGS_PROCESSOR_PROFILE: JSON.stringify(profile),
    READINGS_MODEL_PRICES: JSON.stringify({ "test-model": { inputMxnPerMillion: 15, outputMxnPerMillion: 60 } }), READINGS_REQUEST_TIMEOUT_MS: "1000",
  });
});
afterEach(async () => {
  if (!enabled) return;
  for (const id of allocated.splice(0)) await db.delete(users).where(eq(users.id, id));
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});
after(async () => { await Promise.all([pool.end(), coordinationPool.end()]); });

async function account(verified = true) {
  const [user] = await db.insert(users).values({ name: "Synthetic", email: `${randomUUID()}@example.invalid`, passwordHash: "not-a-real-hash", emailVerifiedAt: verified ? new Date() : null }).returning();
  allocated.push(user.id);
  const [chart] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
  return { user, chart };
}
function response(overrides: Record<string, unknown> = {}) {
  return Response.json({
    model: "test-model", usage: { prompt_tokens: 100, completion_tokens: 100 },
    choices: [{ message: { content: JSON.stringify({ blocks: [{ kind: "prose", text: "Synthetic, not a real reading." }], closingQuestion: "What would you like to reflect on this year?" }) } }],
    ...overrides,
  });
}
function request(method: string, body?: unknown) {
  return new Request("https://app.invalid/api/readings", { method, headers: { "Content-Type": "application/json", Origin: "https://app.invalid" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function deps(user: { id: string; emailVerifiedAt: Date | null }, fetchImpl: typeof fetch, replacementStore = store): ReadingHttpDeps {
  return { user: async () => user, locale: "en", store: replacementStore, config: () => liveGenerationConfig(fetchImpl), throttle: async () => null };
}
async function grant(userId: string) { await store.grant(userId, processorProfile()!, 0, "en"); }
async function ledger(userId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.userId, userId));
  return { run, attempts: run ? await db.select().from(attempts).where(eq(attempts.runId, run.id)) : [] };
}
function barrier() {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

test("real handler → DB → adapter: missing consent/auth/ownership and forged controls make zero calls", gated, async () => {
  const { user, chart } = await account(); const other = await account();
  let calls = 0; const options = deps(user, async () => { calls++; return response(); });
  assert.equal((await handleGeneration(request("POST", { locale: "en" }), chart.id, { ...options, user: async () => null })).status, 401);
  assert.equal((await handleGeneration(request("POST", { locale: "en" }), chart.id, { ...options, user: async () => ({ ...user, emailVerifiedAt: null }) })).status, 401);
  assert.equal((await handleGeneration(request("POST", { locale: "en" }), other.chart.id, options)).status, 404);
  assert.equal((await handleGeneration(request("POST", { locale: "en", tier: "paid", digest: {} }), chart.id, options)).status, 400);
  const refused = await handleGeneration(request("POST", { locale: "en" }), chart.id, options);
  assert.equal(refused.status, 409); assert.equal((await refused.json()).code, "consent_required");
  assert.equal(calls, 0); assert.equal((await ledger(user.id)).run, undefined);
});

test("consent: affirmative versioned grant, stale-grant protection, idempotent withdrawal while disabled", gated, async () => {
  const { user } = await account(); const options = deps(user, async () => response());
  const initial = await (await handleConsent(request("GET"), options)).json();
  assert.equal(initial.active, false); assert.equal(initial.revision, 0); assert.equal(initial.policy.providerName, profile.name);
  assert.equal((await handleConsent(request("PUT", { accepted: false, policyHash: initial.policy.policyHash, expectedRevision: 0 }), options)).status, 400);
  assert.equal((await handleConsent(request("PUT", { accepted: true, policyHash: "0".repeat(64), expectedRevision: 0 }), options)).status, 409);
  const valid = { accepted: true, policyHash: initial.policy.policyHash, expectedRevision: 0 };
  assert.equal((await handleConsent(request("PUT", valid), options)).status, 200);
  const saved = await store.consent(user.id);
  assert.equal(saved?.processorId, profile.id); assert.equal(saved?.policyVersion, profile.policyVersion); assert.ok(saved?.grantedAt);
  process.env.READINGS_GENERATION_ENABLED = "false";
  const withdrawn = await (await handleConsent(request("DELETE"), options)).json();
  assert.equal(withdrawn.revision, 2);
  assert.deepEqual(await (await handleConsent(request("DELETE"), options)).json(), withdrawn);
  process.env.READINGS_GENERATION_ENABLED = "true";
  assert.equal((await handleConsent(request("PUT", valid), options)).status, 409);
  assert.equal((await handleConsent(request("PUT", { ...valid, expectedRevision: 2 }), options)).status, 200);
});

test("two DB connections: one lifetime run; HTTP holds no app-pool connection; repeats freeze chart/locale", gated, async () => {
  const { user, chart } = await account(); await grant(user.id);
  const [another] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
  const secondPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, allowExitOnIdle: true });
  const secondDb = drizzle(secondPool);
  const secondStore = new GenerationStore(secondDb, (id, fn) => withAccountLifecycleLock(id, fn, { pool: secondPool, db: secondDb }));
  const started = barrier(); const resume = barrier(); let calls = 0;
  const http: typeof fetch = async () => { if (++calls === 1) { started.release(); await resume.wait; } return response(); };
  const options = deps(user, http, secondStore);
  const first = handleGeneration(request("POST", { locale: "en" }), chart.id, options);
  try {
    await started.wait;
    const repeated = await handleGeneration(request("POST", { locale: "es" }), another.id, deps(user, http));
    assert.equal(repeated.status, 202); assert.equal((await repeated.json()).readingId, chart.id);
    const probe = await Promise.race([secondPool.query("select 1 as usable"), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pool held across HTTP")), 500))]);
    assert.equal(probe.rows[0].usable, 1);
    const before = await ledger(user.id); assert.equal(before.attempts.length, 1); assert.ok(before.run.consumedAt);
  } finally { resume.release(); }
  try {
    const finished = await first; assert.equal(finished.status, 200);
    const state = await finished.json(); assert.equal(state.status, "completed"); assert.equal(state.locale, "en"); assert.equal(calls, 2);
    process.env.READINGS_GENERATION_ENABLED = "false";
    await store.withdraw(user.id, "en");
    const repeated = await handleGeneration(request("POST", { locale: "es" }), another.id, options);
    assert.deepEqual(await repeated.json(), state); assert.equal(calls, 2);
    assert.equal((await ledger(user.id)).attempts.length, 2);
  } finally { await secondPool.end(); }
});

test("withdrawal during primary: no repair/second section and no document publication", gated, async () => {
  const { user, chart } = await account(); await grant(user.id);
  const started = barrier(); const resume = barrier(); let calls = 0;
  const options = deps(user, async () => { calls++; started.release(); await resume.wait; return response(); });
  const beforeCache = await db.select({ count: sql<number>`count(*)::int` }).from(generationCache);
  const pending = handleGeneration(request("POST", { locale: "en" }), chart.id, options);
  await started.wait;
  try { await store.withdraw(user.id, "es"); } finally { resume.release(); }
  const result = await (await pending).json();
  assert.equal(result.status, "failed"); assert.equal(calls, 1);
  const state = await ledger(user.id); assert.equal(state.attempts[0].state, "measured"); assert.ok(state.attempts[0].costMicros! > 0);
  assert.equal((await db.select().from(readingDocuments).where(eq(readingDocuments.readingId, chart.id))).length, 0);
  assert.deepEqual(await db.select({ count: sql<number>`count(*)::int` }).from(generationCache), beforeCache);
});

test("#129 durable unknown spend survives an all-fallback result, repeat, re-grant and reading deletion", gated, async () => {
  const { user, chart } = await account(); await grant(user.id); let calls = 0;
  const options = deps(user, async () => { calls++; return response({ usage: undefined }); });
  const state = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, options)).json();
  assert.equal(state.status, "indeterminate"); assert.equal(calls, 1);
  const saved = await ledger(user.id); assert.equal(saved.attempts[0].state, "unknown"); assert.equal(saved.attempts[0].costMicros, saved.attempts[0].reservedMicros); assert.ok(saved.attempts[0].costMicros! > 0);
  await store.withdraw(user.id, "en"); await store.grant(user.id, processorProfile()!, 2, "es");
  await handleGeneration(request("POST", { locale: "es" }), chart.id, options); assert.equal(calls, 1);
  assert.equal((await handleReadingDelete(request("DELETE"), chart.id, options)).status, 200);
  const [another] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
  const repeated = await (await handleGeneration(request("POST", { locale: "es" }), another.id, options)).json();
  assert.equal(repeated.status, "free_reading_deleted"); assert.equal(repeated.readingId, null); assert.equal(calls, 1);
  assert.ok((await ledger(user.id)).run.consumedAt);
});

test("account deletion during HTTP cascades new state and a late result cannot recreate it", gated, async () => {
  const { user, chart } = await account(); await grant(user.id);
  const started = barrier(); const resume = barrier(); let calls = 0;
  const options = deps(user, async () => { calls++; started.release(); await resume.wait; return response(); });
  const pending = handleGeneration(request("POST", { locale: "en" }), chart.id, options);
  await started.wait;
  const runId = (await ledger(user.id)).run.id;
  try {
    const removed = await defaultDeleteUser(user.id, async () => { throw new Error("no billing customer exists"); });
    assert.equal(removed.kind, "deleted");
  } finally { resume.release(); }
  assert.equal((await pending).status, 503); assert.equal(calls, 1);
  assert.equal((await db.select().from(runs).where(eq(runs.userId, user.id))).length, 0);
  assert.equal((await db.select().from(consents).where(eq(consents.userId, user.id))).length, 0);
  assert.equal((await db.select().from(attempts).where(eq(attempts.runId, runId))).length, 0);
  assert.equal((await db.select().from(readingDocuments).where(eq(readingDocuments.readingId, chart.id))).length, 0);
});

test("crash recovery: reclaim only pre-permit state; stale owner fenced; committed marker never replayed", gated, async () => {
  const { user, chart } = await account(); await grant(user.id); let calls = 0;
  const http: typeof fetch = async () => { calls++; return response(); };
  const config = liveGenerationConfig(http)!;
  const claimed = await store.claim(user.id, chart.id, "en", config, "synthetic-version");
  assert.equal(claimed.kind, "claimed"); if (claimed.kind !== "claimed") return;
  const oldExecution = store.execution(claimed.run, config, new AbortController().signal, () => true);
  await db.update(runs).set({ deadline: new Date(0) }).where(eq(runs.id, claimed.run.id));
  const state = await (await handleGeneration(request("POST", { locale: "es" }), chart.id, deps(user, http))).json();
  assert.equal(state.status, "completed"); assert.equal(state.locale, "en"); assert.equal((await ledger(user.id)).run.id, claimed.run.id);
  await assert.rejects(() => oldExecution.admit({ section: "overview", phase: "primary", model: "test-model", reservedMicros: 210000 }), /generation_owner_lost/);
  assert.equal(calls, 2);

  const other = await account(); await grant(other.user.id);
  const second = await store.claim(other.user.id, other.chart.id, "en", config, "synthetic-version");
  assert.equal(second.kind, "claimed"); if (second.kind !== "claimed") return;
  const execution = store.execution(second.run, config, new AbortController().signal, () => true);
  const id = await execution.admit({ section: "overview", phase: "primary", model: "test-model", reservedMicros: 210000 });
  await db.update(runs).set({ deadline: new Date(0) }).where(eq(runs.id, second.run.id));
  const repeated = await (await handleGeneration(request("POST", { locale: "en" }), other.chart.id, deps(other.user, http))).json();
  assert.equal(repeated.status, "indeterminate"); assert.equal(calls, 2);
  await assert.rejects(() => execution.assertPermit(id), /generation_deadline/);
  const row = (await ledger(other.user.id)).attempts[0]; assert.equal(row.state, "reserved"); assert.equal(row.reservedMicros, 210000);
});

test("settlement is idempotent, real receipt cannot be clamped, unknown attempts prohibit later admission", gated, async () => {
  const { user, chart } = await account(); await grant(user.id);
  const config = liveGenerationConfig(async () => response())!;
  const claimed = await store.claim(user.id, chart.id, "en", config, "synthetic-version");
  assert.equal(claimed.kind, "claimed"); if (claimed.kind !== "claimed") return;
  const execution = store.execution(claimed.run, config, new AbortController().signal, () => true);
  const id = await execution.admit({ section: "overview", phase: "primary", model: "test-model", reservedMicros: 210000 });
  const receipt = { basis: "measured" as const, costMicros: 6_000_000, usage: { inputTokens: 400_000, outputTokens: 0 }, model: "test-model", latencyMs: 1, code: "measured" };
  assert.equal(await execution.settle(id, receipt), 6_000_000);
  await assert.doesNotReject(async () => {
    assert.equal(await execution.settle(id, { ...receipt, costMicros: 1 }), 6_000_000, "a duplicate cannot replace the first receipt");
  }, "duplicate callbacks remain idempotent even when their proposed receipt conflicts");
  await assert.rejects(() => execution.admit({ section: "sun", phase: "primary", model: "test-model", reservedMicros: 210000 }), /cost_ceiling/);
  const row = (await ledger(user.id)).attempts[0]; assert.equal(row.costMicros, 6_000_000);
  const other = await account(); await grant(other.user.id);
  const unknownRun = await store.claim(other.user.id, other.chart.id, "en", config, "synthetic-version");
  assert.equal(unknownRun.kind, "claimed"); if (unknownRun.kind !== "claimed") return;
  const unknown = store.execution(unknownRun.run, config, new AbortController().signal, () => true);
  const marker = await unknown.admit({ section: "overview", phase: "primary", model: "test-model", reservedMicros: 210000 });
  await unknown.settle(marker, { basis: "unknown", costMicros: 210000, model: null, usage: null, latencyMs: 1, code: "provider_error" });
  await assert.rejects(() => unknown.admit({ section: "sun", phase: "primary", model: "test-model", reservedMicros: 210000 }), /generation_indeterminate/);
});

test("actual primary and repair payloads exclude raw identity/birth data; failures never echo vendor text", gated, async () => {
  const { user, chart } = await account(); await grant(user.id);
  const payloads: string[] = []; let calls = 0;
  const options = deps(user, async (_url, init) => {
    payloads.push(String(init?.body));
    return ++calls === 1 ? response({ choices: [{ message: { content: JSON.stringify({ PRIVATE_RESPONSE_SECRET_SENTINEL: true }) } }] }) : response();
  });
  const answer = await handleGeneration(request("POST", { locale: "en" }), chart.id, options);
  assert.equal((await answer.json()).status, "completed"); assert.equal(calls, 3);
  assert.match(payloads[1], /previous response was rejected/);
  for (const payload of payloads) {
    for (const sentinel of [input.name, input.birthDate, input.birthPlace.name, input.returnPlace.name, user.email, user.id, "FAKE_PROVIDER_KEY_SENTINEL", "PRIVATE_RESPONSE_SECRET_SENTINEL"]) assert.equal(payload.includes(sentinel), false, sentinel);
    const body = JSON.parse(payload); assert.equal(body.max_tokens, 2000);
  }
  const [doc] = await db.select().from(readingDocuments).where(eq(readingDocuments.readingId, chart.id));
  assert.equal(JSON.stringify(doc.document).includes("PRIVATE_RESPONSE_SECRET_SENTINEL"), false);
  assert.ok(doc.document.accounting?.settled); assert.equal(doc.document.accounting?.uncertainMxn, 0);
});

test("disabled/config failure and GET status consume nothing; deleted pre-permit chart can be rebound", gated, async () => {
  const { user, chart } = await account(); let calls = 0;
  const http: typeof fetch = async () => { calls++; return response(); }; const options = deps(user, http);
  assert.equal((await (await handleGeneration(request("GET"), chart.id, options)).json()).status, "unused");
  process.env.READINGS_GENERATION_ENABLED = "false";
  assert.equal((await handleGeneration(request("POST", { locale: "en" }), chart.id, options)).status, 503);
  assert.equal((await ledger(user.id)).run, undefined); assert.equal(calls, 0);
  process.env.READINGS_GENERATION_ENABLED = "true"; await grant(user.id);
  const config = liveGenerationConfig(http)!;
  const claimed = await store.claim(user.id, chart.id, "en", config, "synthetic-version");
  assert.equal(claimed.kind, "claimed"); if (claimed.kind !== "claimed") return;
  await store.deleteReading(user.id, chart.id);
  await db.update(runs).set({ deadline: new Date(0) }).where(eq(runs.id, claimed.run.id));
  const [newChart] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
  const completed = await (await handleGeneration(request("POST", { locale: "en" }), newChart.id, options)).json();
  assert.equal(completed.status, "completed"); assert.equal((await ledger(user.id)).run.id, claimed.run.id);
  assert.equal(calls, 2);
});


test("database constraints independently prohibit duplicate lifetime claims and attempt slots", gated, async () => {
  const { user, chart } = await account(); await grant(user.id);
  await handleGeneration(request("POST", { locale: "en" }), chart.id, deps(user, async () => response()));
  const state = await ledger(user.id);
  const unique = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23505";
  await assert.rejects(() => db.insert(runs).values({ ...state.run, id: randomUUID() }), unique);
  await assert.rejects(() => db.insert(attempts).values({ ...state.attempts[0], id: randomUUID() }), unique);
});

test("withdrawal before permit commits admits zero attempts; new policy cannot inherit old consent", gated, async () => {
  const { user, chart } = await account(); await grant(user.id);
  const config = liveGenerationConfig(async () => response())!;
  const claimed = await store.claim(user.id, chart.id, "en", config, "synthetic-version");
  assert.equal(claimed.kind, "claimed"); if (claimed.kind !== "claimed") return;
  const execution = store.execution(claimed.run, config, new AbortController().signal, () => true);
  await store.withdraw(user.id, "en");
  await assert.rejects(() => execution.admit({ section: "overview", phase: "primary", model: "test-model", reservedMicros: 210000 }), /consent_required/);
  assert.equal((await ledger(user.id)).attempts.length, 0); assert.equal((await ledger(user.id)).run.consumedAt, null);
  await store.finish(claimed.run, null, () => false);
  await store.grant(user.id, processorProfile()!, 2, "en");
  process.env.READINGS_PROCESSOR_PROFILE = JSON.stringify({ ...profile, policyVersion: "test-v2" });
  let calls = 0;
  const answer = await handleGeneration(request("POST", { locale: "en" }), chart.id, deps(user, async () => { calls++; return response(); }));
  assert.equal(answer.status, 409); assert.equal(calls, 0);
});

test("individual deletion during HTTP keeps consumed claim, settles receipt, blocks later dispatch/publication", gated, async () => {
  const { user, chart } = await account(); await grant(user.id);
  const started = barrier(); const resume = barrier(); let calls = 0;
  const options = deps(user, async () => { calls++; started.release(); await resume.wait; return response(); });
  const pending = handleGeneration(request("POST", { locale: "en" }), chart.id, options);
  await started.wait;
  try { assert.equal((await handleReadingDelete(request("DELETE"), chart.id, options)).status, 200); }
  finally { resume.release(); }
  assert.equal((await (await pending).json()).status, "free_reading_deleted"); assert.equal(calls, 1);
  const state = await ledger(user.id); assert.ok(state.run.consumedAt); assert.equal(state.run.readingId, null); assert.equal(state.attempts[0].state, "measured");
});

test("real ledger UPDATE failure keeps reservation and halts without a document or second call", gated, async () => {
  const { user, chart } = await account(); await grant(user.id); let calls = 0;
  const suffix = randomUUID().replaceAll("-", "");
  const name = `reading_test_failure_${suffix}`;
  const options = deps(user, async () => {
    calls++;
    const run = (await ledger(user.id)).run;
    // A real database failure, not a fake ledger: only this run's update is rejected.
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ledger failure' USING ERRCODE = '57014'; END $$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON reading_generation_attempts FOR EACH ROW WHEN (OLD.run_id = '${run.id}'::uuid) EXECUTE FUNCTION ${name}()`);
    return response();
  });
  try {
    const answer = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, options)).json();
    assert.equal(answer.status, "indeterminate"); assert.equal(calls, 1);
    const state = await ledger(user.id); assert.equal(state.attempts[0].state, "reserved"); assert.equal(state.attempts[0].costMicros, null); assert.ok(state.attempts[0].reservedMicros > 0);
    assert.equal((await db.select().from(readingDocuments).where(eq(readingDocuments.readingId, chart.id))).length, 0);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON reading_generation_attempts`);
    await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
  }
});


test("chart creation is chart-only even with consent, a valid live profile and generation enabled", gated, async t => {
  const { user } = await account(); await grant(user.id); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  const saved = await handleChartSave(request("POST", input), {
    user: async () => user, locale: "en", budgets: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  });
  assert.equal(saved.status, 200); const value = await saved.json();
  assert.deepEqual(Object.keys(value), ["id"]);
  assert.ok((await db.select().from(readings).where(eq(readings.id, value.id))).length);
  assert.equal(calls, 0); assert.equal((await ledger(user.id)).run, undefined);
  const status = await (await handleGeneration(request("GET"), value.id, deps(user, globalThis.fetch))).json();
  assert.equal(status.status, "unused"); assert.equal(calls, 0); assert.equal((await ledger(user.id)).run, undefined);
});


test("publication INSERT failure keeps receipts, never replays, and serializes no database/provider secrets", gated, async t => {
  const { user, chart } = await account(); await grant(user.id); let calls = 0;
  const lines: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { lines.push(args); });
  t.mock.method(console, "warn", (...args: unknown[]) => { lines.push(args); });
  const name = `reading_publication_${randomUUID().replaceAll("-", "")}`;
  const sentinel = "PRIVATE_DATABASE_BODY_SENTINEL";
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${sentinel}' USING ERRCODE = '57014'; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON reading_documents FOR EACH ROW WHEN (NEW.reading_id = '${chart.id}'::uuid) EXECUTE FUNCTION ${name}()`);
  const options = deps(user, async () => { calls++; return response(); });
  try {
    const answer = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, options)).json();
    assert.equal(answer.status, "failed"); assert.equal(calls, 2);
    const state = await ledger(user.id);
    assert.equal(state.attempts.length, 2); assert.ok(state.attempts.every(row => row.state === "measured" && row.costMicros! > 0));
    assert.equal((await db.select().from(readingDocuments).where(eq(readingDocuments.readingId, chart.id))).length, 0);
    assert.deepEqual(await (await handleGeneration(request("POST", { locale: "es" }), chart.id, options)).json(), answer);
    assert.equal(calls, 2);
    assert.ok(lines.length > 0, "failure is logged, not silently swallowed");
    for (const privateValue of [sentinel, input.name, input.birthDate, input.birthPlace.name, user.email, "FAKE_PROVIDER_KEY_SENTINEL"]) {
      assert.equal(JSON.stringify({ answer, lines, state }).includes(privateValue), false, privateValue);
    }
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${name} ON reading_documents`);
    await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
  }
});

test("real HTTP throttles bound generation, consent and status without consuming an allowance", gated, async () => {
  const { user, chart } = await account(); let calls = 0;
  const ip = `2001:db8::${randomUUID().slice(0, 4)}`;
  const options = { ...deps(user, async () => { calls++; return response(); }), throttle: undefined };
  const keys = [keyFor("readings:generate:user", user.id), keyFor("readings:generate:ip", ip), keyFor("readings:consent:user", user.id), keyFor("readings:status:user", user.id)];
  function req(method: string, value?: unknown) { const r = request(method, value); r.headers.set("x-forwarded-for", ip); return r; }
  try {
    for (let i = 0; i < AUTH_RATE_LIMITS.readingsGenerateUser.limit; i++) {
      assert.equal((await handleGeneration(req("POST", { locale: "en" }), chart.id, options)).status, 409);
    }
    const limited = await handleGeneration(req("POST", { locale: "en" }), chart.id, options);
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("Retry-After")) > 0); assert.match(limited.headers.get("Cache-Control")!, /no-store/);
    for (let i = 0; i < AUTH_RATE_LIMITS.readingsConsentUser.limit; i++) assert.equal((await handleConsent(req("DELETE"), options)).status, 200);
    assert.equal((await handleConsent(req("DELETE"), options)).status, 429);
    for (let i = 0; i < AUTH_RATE_LIMITS.readingsStatusUser.limit; i++) assert.equal((await handleGeneration(req("GET"), chart.id, options)).status, 200);
    assert.equal((await handleGeneration(req("GET"), chart.id, options)).status, 429);
    assert.equal(calls, 0); assert.equal((await ledger(user.id)).run, undefined);
  } finally { for (const key of keys) await db.delete(rateLimits).where(eq(rateLimits.key, key)); }
});

test("deadline, configuration change and consent re-grant during HTTP cannot authorize a repair or publication", gated, async () => {
  for (const change of ["deadline", "configuration", "regrant"] as const) {
    const { user, chart } = await account(); await grant(user.id); let calls = 0;
    const options = deps(user, async () => {
      calls++;
      if (change === "deadline") await db.update(runs).set({ deadline: new Date(0) }).where(eq(runs.userId, user.id));
      else if (change === "configuration") process.env.READINGS_MODEL_PRICES = JSON.stringify({ "test-model": { inputMxnPerMillion: 16, outputMxnPerMillion: 60 } });
      else { await store.withdraw(user.id, "en"); await store.grant(user.id, processorProfile()!, 2, "en"); }
      return response({ choices: [{ message: { content: "{}" } }] });
    });
    const state = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, options)).json();
    assert.equal(state.status, "failed", change); assert.equal(calls, 1, change);
    const saved = await ledger(user.id); assert.equal(saved.attempts[0].state, "measured"); assert.ok(saved.run.consumedAt);
    assert.equal((await db.select().from(readingDocuments).where(eq(readingDocuments.readingId, chart.id))).length, 0);
  }
});

test("finalization rechecks configuration after handing off to the lifecycle boundary", gated, async t => {
  const { user, chart } = await account(); await grant(user.id);
  const original = store.finish.bind(store);
  t.mock.method(store, "finish", async (...args: Parameters<typeof original>) => {
    // The pipeline has completed, but final publication has not obtained its fence.
    process.env.READINGS_GENERATION_ENABLED = "false";
    return original(...args);
  });
  const state = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, deps(user, async () => response()))).json();
  assert.equal(state.status, "failed");
  assert.equal((await db.select().from(readingDocuments).where(eq(readingDocuments.readingId, chart.id))).length, 0);
  assert.equal((await ledger(user.id)).attempts.length, 2);
});

test("withdrawal between committed permit and send consumes offer but releases positively unsent money", gated, async t => {
  const { user, chart } = await account(); await grant(user.id); let calls = 0;
  const original = store.execution.bind(store);
  t.mock.method(store, "execution", (...args: Parameters<typeof original>) => {
    const execution = original(...args);
    return { ...execution, assertPermit: async (id: string) => { await store.withdraw(user.id, "en"); await execution.assertPermit(id); } };
  });
  const options = deps(user, async () => { calls++; return response(); });
  const state = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, options)).json();
  assert.equal(state.status, "failed"); assert.equal(calls, 0);
  const saved = await ledger(user.id); assert.ok(saved.run.consumedAt); assert.equal(saved.attempts.length, 1);
  assert.equal(saved.attempts[0].state, "not_dispatched"); assert.equal(saved.attempts[0].costMicros, 0);
  await store.grant(user.id, processorProfile()!, 2, "en");
  await handleGeneration(request("POST", { locale: "en" }), chart.id, options);
  assert.equal(calls, 0, "releasing money never resets the allowance");
});

test("request cancellation during real adapter HTTP retains unknown exposure and never retries", gated, async () => {
  const { user, chart } = await account(); await grant(user.id); let calls = 0;
  const controller = new AbortController();
  const options = deps(user, async () => { calls++; controller.abort(); return new Promise<Response>(() => { /* no response/receipt before cancellation */ }); });
  const abortedRequest = new Request(request("POST", { locale: "en" }), { signal: controller.signal });
  const state = await (await handleGeneration(abortedRequest, chart.id, options)).json();
  assert.equal(state.status, "indeterminate"); assert.equal(calls, 1);
  const saved = await ledger(user.id); assert.equal(saved.attempts[0].state, "unknown"); assert.ok(saved.attempts[0].costMicros! > 0);
  await handleGeneration(request("POST", { locale: "en" }), chart.id, options); assert.equal(calls, 1);
});


test("live service never accesses the unowned shared persistent cache", gated, async t => {
  const { user, chart } = await account(); await grant(user.id); let cacheCalls = 0;
  t.mock.method(DbSectionCache.prototype, "get", async () => { cacheCalls++; throw new Error("no shared cache access allowed"); });
  t.mock.method(DbSectionCache.prototype, "put", async () => { cacheCalls++; throw new Error("no shared cache access allowed"); });
  const state = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, deps(user, async () => response()))).json();
  assert.equal(state.status, "completed"); assert.equal(cacheCalls, 0);
});

test("real adapter transport failures never persist or log private payloads", gated, async t => {
  const lines: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { lines.push(args); });
  t.mock.method(console, "warn", (...args: unknown[]) => { lines.push(args); });
  const sentinel = "PRIVATE_VENDOR_SENTINEL";
  const scenarios: Array<() => Promise<Response>> = [
    async () => { throw new Error(sentinel); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(sentinel)); } })),
    async () => new Response(sentinel),
    async () => Response.json({ error: { message: sentinel } }, { status: 500 }),
    async () => response({ usage: { prompt_tokens: sentinel, completion_tokens: -1 } }),
    async () => response({ model: sentinel }),
  ];
  for (const scenario of scenarios) {
    const { user, chart } = await account(); await grant(user.id); let calls = 0;
    const options = deps(user, async () => { calls++; return scenario(); });
    const answer = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, options)).json();
    assert.equal(answer.status, "indeterminate"); assert.equal(calls, 1);
    const state = await ledger(user.id); assert.equal(state.attempts[0].state, "unknown"); assert.ok(state.attempts[0].costMicros! > 0);
    for (const privateValue of [sentinel, input.name, input.birthDate, input.birthPlace.name, user.email, "FAKE_PROVIDER_KEY_SENTINEL"]) {
      assert.equal(JSON.stringify({ answer, lines, state }).includes(privateValue), false, privateValue);
    }
  }
});

for (const mode of ["HTTP 500", "HTTP 429", "error envelope"] as const) {
  test(`PR148 R1: ${mode} with a valid receipt settles once and halts`, gated, async () => {
    const { user, chart } = await account(); await grant(user.id); let calls = 0;
    const options = deps(user, async () => {
      calls++;
      return new Response(await response(mode === "error envelope" ? { error: { message: "PRIVATE_PROVIDER_ERROR" } } : {}).text(), {
        status: mode === "HTTP 500" ? 500 : mode === "HTTP 429" ? 429 : 200,
      });
    });
    const state = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, options)).json();
    assert.equal(state.status, "failed"); assert.equal(calls, 1, "provider failure is not a schema-repair opportunity");
    const saved = await ledger(user.id); assert.equal(saved.attempts.length, 1);
    assert.equal(saved.attempts[0].state, "measured"); assert.equal(saved.attempts[0].code, "provider_error");
    assert.equal(saved.attempts[0].costMicros, 7500); assert.ok(saved.run.consumedAt);
    assert.deepEqual(saved.attempts[0].usage, { inputTokens: 100, outputTokens: 100 });
    assert.equal((await db.select().from(readingDocuments).where(eq(readingDocuments.readingId, chart.id))).length, 0);
    assert.equal(JSON.stringify({ state, saved }).includes("PRIVATE_PROVIDER_ERROR"), false);
    assert.deepEqual(await (await handleGeneration(request("POST", { locale: "es" }), chart.id, options)).json(), state);
    assert.equal(calls, 1, "the measured failure cannot replay on another locale");
  });
}

test("PR148 R1: a measured provider error during repair preserves both receipts and stops before sun", gated, async () => {
  const { user, chart } = await account(); await grant(user.id); let calls = 0;
  const options = deps(user, async () => ++calls === 1
    ? response({ choices: [{ message: { content: "{}" } }] })
    : new Response(await response().text(), { status: 429 }));
  const state = await (await handleGeneration(request("POST", { locale: "en" }), chart.id, options)).json();
  assert.equal(state.status, "failed"); assert.equal(calls, 2);
  const saved = await ledger(user.id);
  assert.equal(saved.attempts.length, 2); assert.ok(saved.attempts.every(attempt => attempt.state === "measured" && attempt.costMicros === 7500));
  assert.equal(saved.attempts.find(attempt => attempt.phase === "repair")?.code, "provider_error");
});


for (const scenario of ["withdrawal", "disable", "delete", "preparation", "exception"] as const) {
  test(`PR148 R2: post-claim ${scenario} returns an error and keeps the same unused offer recoverable`, gated, async t => {
    const { user, chart } = await account(); await grant(user.id); let calls = 0;
    const http: typeof fetch = async () => { calls++; return response(); };
    const config = liveGenerationConfig(http)!;
    const options = { ...deps(user, http), config: () => config };
    let inject = true;
    const original = store.claim.bind(store);
    t.mock.method(store, "claim", async (...args: Parameters<typeof original>) => {
      const claimed = await original(...args);
      if (claimed.kind === "claimed" && inject && scenario !== "preparation") {
        inject = false;
        if (scenario === "withdrawal") await store.withdraw(user.id, "en");
        if (scenario === "disable") process.env.READINGS_GENERATION_ENABLED = "false";
        if (scenario === "delete") await store.deleteReading(user.id, chart.id);
        if (scenario === "exception") claimed.input = { ...claimed.input, birthDate: "PRIVATE_INVALID_INPUT" };
      }
      return claimed;
    });
    if (scenario === "preparation") {
      const prepare = config.provider.prepare!.bind(config.provider);
      t.mock.method(config.provider, "prepare", (...args: Parameters<typeof prepare>) => {
        if (inject) { inject = false; throw new GenerationBlocked("cost_ceiling"); }
        return prepare(...args);
      });
    }
    const answer = await handleGeneration(request("POST", { locale: "en" }), chart.id, options);
    assert.equal(answer.status, scenario === "withdrawal" ? 409 : scenario === "delete" ? 404 : 503);
    assert.deepEqual(await answer.json(), { code: scenario === "withdrawal" ? "consent_required" : scenario === "delete" ? "not_found" : scenario === "disable" ? "generation_disabled" : scenario === "preparation" ? "cost_ceiling" : "generation_unavailable" });
    const saved = await ledger(user.id);
    assert.equal(calls, 0); assert.equal(saved.attempts.length, 0); assert.equal(saved.run.consumedAt, null); assert.equal(saved.run.owner, null);
    let retryId = chart.id;
    if (scenario === "withdrawal") await store.grant(user.id, processorProfile()!, 2, "en");
    if (scenario === "disable") process.env.READINGS_GENERATION_ENABLED = "true";
    if (scenario === "delete") {
      const [replacement] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning();
      retryId = replacement.id;
    }
    assert.equal((await (await handleGeneration(request("GET"), retryId, options)).json()).status, "unused");
    const retried = await handleGeneration(request("POST", { locale: "es" }), retryId, options);
    assert.equal(retried.status, 200); assert.equal((await retried.json()).status, "completed"); assert.equal(calls, 2);
    const recovered = await ledger(user.id); assert.equal(recovered.run.id, saved.run.id); assert.equal(recovered.run.locale, "en");
  });
}
