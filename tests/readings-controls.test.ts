import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { GenerationView } from "../src/readings/generation-view";
import { pollReadingStatus, publicGenerationView, publicationToRefresh, retryAfterMs, STATUS_POLL_LIMITS, type PollStop, type StatusPollEnvironment } from "../src/readings/status-polling";

const readingId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const status = (state: GenerationView["status"] = "in_progress"): GenerationView => ({ status: state, readingId, documentId: state === "completed" ? documentId : null, locale: "en" });
function clock(reply: (count: number, init: RequestInit) => Promise<Response> = async () => Response.json(status())) {
  let time = 0; let nextId = 0; let hidden = false;
  const jobs = new Map<number, { due: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  const calls: { url: string; init: RequestInit; at: number }[] = [];
  const views: GenerationView[] = []; const stops: { reason: PollStop; retryAt: number }[] = [];
  const env: StatusPollEnvironment = {
    fetch: (async (url, init = {}) => { calls.push({ url: String(url), init, at: time }); return reply(calls.length, init); }) as typeof fetch,
    now: () => time, hidden: () => hidden,
    later: (fn, ms) => { const id = ++nextId; jobs.set(id, { due: time + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    cancel: timer => { jobs.delete(timer as unknown as number); },
    onHidden: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  async function advance(ms: number) {
    const target = time + ms; let guard = 0;
    for (;;) {
      const entry = [...jobs].sort((a, b) => a[1].due - b[1].due)[0];
      if (!entry || entry[1].due > target) break;
      assert.ok(++guard < 1000, "finite scheduler");
      time = entry[1].due; jobs.delete(entry[0]); entry[1].fn(); await setImmediate();
    }
    time = target; await setImmediate();
  }
  return { env, calls, views, stops, jobs, advance, hide() { hidden = true; listeners.forEach(fn => fn()); },
    start(immediate = true) { return pollReadingStatus({ readingId, immediate, onView: view => views.push(view), onStop: (reason, retryAt) => stops.push({ reason, retryAt }) }, env); },
  };
}

test("status: validate only public bounded identity/status fields", () => {
  assert.deepEqual(publicGenerationView({ ...status(), secret: "PRIVATE_SENTINEL" }), status());
  for (const bad of [null, {}, { ...status(), locale: "fr" }, { ...status(), readingId: "../foreign" }, { ...status(), status: "retry_me" }]) assert.equal(publicGenerationView(bad), null);
  assert.equal(retryAfterMs("15", 0), 15000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", 1000), 59000);
  assert.equal(retryAfterMs("invalid", 0), 0);
});

test("polling: unused/terminal initial GET stops; never PUT/POST/consent", async () => {
  const c = clock(async () => Response.json(status("unused"))); c.start(); await c.advance(120000);
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].init.method, "GET");
  assert.equal(c.calls[0].init.cache, "no-store"); assert.equal(c.calls[0].url, `/api/readings/${readingId}/generation`);
  assert.equal(c.stops[0].reason, "terminal"); assert.equal(c.jobs.size, 0);
});

test("polling: 3/6/10 second backoff and a 60 second total budget", async () => {
  const c = clock(); c.start(); await c.advance(300000);
  assert.deepEqual(c.calls.map(call => call.at), [0, 3000, 9000, 19000, 29000, 39000, 49000, 59000]);
  assert.equal(c.stops.at(-1)?.reason, "budget"); assert.equal(c.jobs.size, 0);
  assert.ok(c.calls.every(call => call.init.method === "GET"));
});

test("polling: hard request cap still holds if a clock stops advancing", async () => {
  const c = clock(); c.env.now = () => 0; c.start(); await c.advance(600000);
  assert.equal(c.calls.length, STATUS_POLL_LIMITS.requests); assert.equal(c.stops.at(-1)?.reason, "budget");
});

test("polling: 429 honors Retry-After and does not fetch consent", async () => {
  const c = clock(async count => count === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "15" } }) : Response.json(status("completed")));
  c.start(); await c.advance(14999); assert.equal(c.calls.length, 1);
  await c.advance(1); assert.equal(c.calls.length, 2); assert.equal(c.stops.at(-1)?.reason, "terminal");
  assert.equal(c.views[0].documentId, documentId);
});

test("polling: server delay beyond the total budget stops with an explicit retry time", async () => {
  const c = clock(async () => new Response(null, { status: 429, headers: { "Retry-After": "600" } })); c.start(); await c.advance(1000000);
  assert.equal(c.calls.length, 1); assert.deepEqual(c.stops, [{ reason: "rate_limited", retryAt: 600000 }]);
});

for (const code of [401, 404, 503]) test(`polling: HTTP ${code} terminates without a mutation or automatic retry`, async () => {
  const c = clock(async () => new Response(null, { status: code })); c.start(); await c.advance(100000);
  assert.equal(c.calls.length, 1); assert.equal(c.stops.at(-1)?.reason, code === 503 ? "error" : "unauthorized");
});

test("polling: offline/invalid JSON stops, no POST fallback", async () => {
  for (const reply of [async () => { throw new Error("offline"); }, async () => new Response("not JSON")]) {
    const c = clock(reply); c.start(); await c.advance(100000);
    assert.equal(c.calls.length, 1); assert.equal(c.stops.at(-1)?.reason, "error");
  }
});

test("polling: hidden tab aborts and ignores a late success, no automatic resume", async () => {
  let deliver!: (value: Response) => void;
  const c = clock(() => new Promise(resolve => { deliver = resolve; })); c.start(); await c.advance(0); c.hide();
  assert.equal(c.calls[0].init.signal?.aborted, true);
  deliver(Response.json(status("completed"))); await c.advance(120000);
  assert.equal(c.views.length, 0); assert.equal(c.calls.length, 1); assert.equal(c.stops[0].reason, "hidden");
  const hidden = clock(); hidden.hide(); hidden.start(); await hidden.advance(100000); assert.equal(hidden.calls.length, 0);
});

test("polling: unmount/chart/locale cleanup ignores stale responses and tears down every timer", async () => {
  let deliver!: (value: Response) => void;
  const c = clock(() => new Promise(resolve => { deliver = resolve; })); const cleanup = c.start(); await c.advance(0); cleanup();
  deliver(Response.json(status("completed"))); await c.advance(120000);
  assert.equal(c.views.length, 0); assert.equal(c.stops.length, 0); assert.equal(c.jobs.size, 0);
  assert.equal(c.calls[0].init.signal?.aborted, true);
});

test("polling: a hung request is aborted within its own/total budget", async () => {
  const c = clock(() => new Promise(() => {})); c.start(); await c.advance(8000);
  assert.equal(c.calls[0].init.signal?.aborted, true); assert.equal(c.stops.at(-1)?.reason, "error");
  assert.equal(c.jobs.size, 0);
});

test("refresh: once per published identity for this chart, including unavailable projections", () => {
  const seen = new Set<string>(); const completed = status("completed");
  assert.equal(publicationToRefresh(completed, undefined, seen), null);
  assert.equal(publicationToRefresh(completed, documentId, seen), null);
  assert.equal(publicationToRefresh({ ...completed, status: "in_progress" }, readingId, seen), null);
  assert.equal(publicationToRefresh(completed, readingId, seen), documentId);
  assert.equal(publicationToRefresh(completed, readingId, seen), null);
  assert.equal(publicationToRefresh({ ...completed, status: "partial" }, readingId, seen), null);
  assert.equal(publicationToRefresh(completed, readingId, new Set([documentId])), null, "already visible on initial SSR");
});
