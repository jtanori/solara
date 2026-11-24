import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import type { Route } from "playwright-core";
import { startControlBrowser } from "./helpers/control-browser";
import { PAID_CORE_SECTIONS, PAID_PROFILE, type PaidOffer, type PaidRunView } from "../src/readings/paid-contract";
import { publicPaidOffer } from "../src/readings/paid-polling";

const readingId = "22222222-2222-4222-8222-222222222222";
const editionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
let site: Awaited<ReturnType<typeof startControlBrowser>>;
before(async () => { site = await startControlBrowser("tests/browser/paid-controls.tsx"); });
after(async () => { await site?.close(); });
const policy = { policyHash: "a".repeat(64), policyVersion: "synthetic/1", disclosure: "Synthetic named-processor disclosure", providerName: "Synthetic Provider" };
const consent = (active = false) => ({ available: true, active, revision: 0, policy });
const run = (status: PaidRunView["status"] = "generating"): PaidRunView => ({ id: runId, readingId, editionId: status === "completed" ? editionId : null,
  locale: "en", profile: PAID_PROFILE, period: "2026-11", status, completedSections: status === "completed" ? 9 : 0, totalSections: 9, allowanceConsumed: status !== "queued", reason: null });
const offer = (runs: PaidRunView[] = []): PaidOffer => ({ profile: PAID_PROFILE, sections: PAID_CORE_SECTIONS, houseSystem: "Placidus", locale: "en", period: "2026-11",
  available: true, entitled: true, allowance: runs.length ? "consumed" : "available", offerHash: "b".repeat(64), runs, nextCursor: null });
const json = (route: Route, value: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value), headers });
async function fixture(reply: (route: Route) => Promise<void>, locale: "en" | "es" = "en") {
  const context = await site.browser.newContext(); const page = await context.newPage();
  const errors: string[] = []; const calls: { path: string; method: string; body: string | null }[] = [];
  page.on("pageerror", error => errors.push(error.message)); await page.clock.install();
  await page.route("**/api/readings/**", async route => { calls.push({ path: new URL(route.request().url()).pathname, method: route.request().method(), body: route.request().postData() }); await reply(route); });
  await page.addInitScript(props => { Object.assign(window, { paidProps: props }); }, { readingId, locale });
  await page.goto(site.origin); await page.clock.runFor(20);
  return { page, calls, errors, close: async () => { try { assert.deepEqual(errors, [], "no client/hydration errors"); } finally { await context.close(); } } };
}

test("paid controls: runtime decoder rejects a forged manifest and strips private fields", () => {
  assert.deepEqual(publicPaidOffer({ ...offer(), rawSnapshot: "PRIVATE" }), offer());
  assert.equal(publicPaidOffer({ ...offer(), sections: ["overview", "sun"] }), null);
  assert.equal(publicPaidOffer({ ...offer(), runs: [{ ...run(), readingId: "../other" }] }), null);
});

for (const locale of ["en", "es"] as const) test(`paid controls: ${locale} requires explicit allowance confirmation and processor consent; publication is a pinned link, not a refresh/replacement`, async () => {
  let posted = false;
  const f = await fixture(async route => {
    if (route.request().method() === "PUT") return json(route, { revision: 1 });
    if (route.request().method() === "POST") { posted = true; return json(route, run("queued"), 202); }
    if (route.request().url().endsWith("consent")) return json(route, consent());
    return json(route, { ...offer(posted ? [run("completed")] : []), locale });
  }, locale);
  try {
    const button = f.page.getByRole("button", { name: locale === "es" ? "Solicitar mi edición de pago" : "Request my paid edition", exact: true });
    await button.waitFor(); assert.equal(await button.isEnabled(), false); assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
    const permission = f.page.locator('input[name="paid-ai-consent"]'); await permission.focus(); await permission.press("Space"); assert.equal(await button.isEnabled(), false);
    const allowance = f.page.locator('input[name="paid-allowance-confirmation"]'); await allowance.focus(); await allowance.press("Space"); assert.equal(await button.isEnabled(), true);
    await button.focus(); await button.press("Enter"); await f.page.getByRole("button", { name: locale === "es" ? "Detener solicitud" : "Stop request", exact: true }).waitFor();
    await f.page.clock.runFor(3100);
    const link = f.page.getByRole("link", { name: locale === "es" ? "Abrir esta edición guardada" : "Open this saved edition", exact: true }); await link.waitFor();
    assert.equal(await link.getAttribute("href"), `/reading/${readingId}?paidEdition=${editionId}`);
    assert.equal(f.calls.filter(call => call.method === "PUT").length, 1); assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
    const body = JSON.parse(f.calls.find(call => call.method === "POST")!.body!); assert.equal(body.locale, locale); assert.equal(body.profile, PAID_PROFILE); assert.equal(body.period, "2026-11");
    assert.deepEqual(Object.keys(body).sort(), ["locale", "offerHash", "period", "profile", "requestId"]);
    assert.equal(f.calls.some(call => call.path.endsWith("generate")), false, "paid-first UI never invokes free generation");
  } finally { await f.close(); }
});

test("paid controls: lost POST is followed by GET only, never automatic repair/translation or re-submission", async () => {
  let posted = false;
  const f = await fixture(async route => {
    if (route.request().url().endsWith("consent")) return json(route, consent(true));
    if (route.request().method() === "POST") { posted = true; return route.abort("failed"); }
    return json(route, offer(posted ? [run("completed")] : []));
  });
  try {
    await f.page.locator('input[name="paid-allowance-confirmation"]').check(); await f.page.getByRole("button", { name: "Request my paid edition", exact: true }).click();
    await f.page.getByRole("alert").waitFor(); await f.page.clock.runFor(3100);
    // Let the mocked network response settle before advancing the entire clock
    // budget; otherwise the fake 8s timeout can overtake real browser I/O.
    await f.page.getByRole("link", { name: "Open this saved edition", exact: true }).waitFor();
    await f.page.clock.runFor(65000);
    await f.page.getByLabel("Language for a new edition", { exact: true }).selectOption("es"); await f.page.clock.runFor(50);
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1); assert.equal(f.calls.filter(call => call.method === "PUT").length, 0);
    assert.equal(await f.page.getByRole("link", { name: "Open this saved edition", exact: true }).getAttribute("href"), `/reading/${readingId}?paidEdition=${editionId}`);
  } finally { await f.close(); }
});

test("paid controls: close/unmount stops only polling; explicit stop is its own mutation", async () => {
  for (const stop of [false, true]) {
    let stopped = false;
    const f = await fixture(async route => {
      if (route.request().url().endsWith("consent")) return json(route, consent(true));
      if (route.request().method() === "POST") { assert.ok(route.request().url().endsWith(`/${runId}/stop`)); stopped = true; return json(route, run("stopped")); }
      return json(route, offer([run(stopped ? "stopped" : "generating")]));
    });
    try {
      const button = f.page.getByRole("button", { name: "Stop request", exact: true }); await button.waitFor();
      if (stop) { await button.click(); await f.page.clock.runFor(30); await f.page.getByText("Stopped; no more requests will be authorized", { exact: true }).waitFor(); }
      await f.page.evaluate(() => (window as unknown as { mountPaidControls: (props: null) => void }).mountPaidControls(null)); await f.page.clock.runFor(65000);
      assert.equal(f.calls.filter(call => call.method === "POST").length, stop ? 1 : 0); assert.equal(f.calls.filter(call => call.method === "PUT").length, 0);
      assert.ok(f.calls.filter(call => call.path.endsWith("paid")).length <= (stop ? 2 : 1));
    } finally { await f.close(); }
  }
});

test("paid controls: generation-off, no entitlement or spent allowance cannot display a request action", async () => {
  for (const change of [{ available: false }, { entitled: false }, { allowance: "consumed" as const }]) {
    const f = await fixture(async route => json(route, route.request().url().endsWith("consent") ? consent(true) : { ...offer(), ...change }));
    try {
      await f.page.getByRole("button", { name: "Check status", exact: true }).waitFor();
      assert.equal(await f.page.getByRole("button", { name: "Request my paid edition", exact: true }).count(), 0);
      assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
      if (change.entitled === false) assert.equal(await f.page.getByRole("link", { name: "View Premium", exact: true }).getAttribute("href"), `/pricing?reading=${readingId}`);
    } finally { await f.close(); }
  }
});

test("paid controls: finite polling and Retry-After keep a ten-minute job independent of the browser timer", async () => {
  for (const mode of ["budget", "429", "hidden"] as const) {
    const f = await fixture(async route => route.request().url().endsWith("consent") ? json(route, consent()) : json(route, offer([run()]), mode === "429" ? 429 : 200, mode === "429" ? { "Retry-After": "600" } : {}));
    try {
      await f.page.getByRole("heading", { name: "Your complete interpretation · Placidus", exact: true }).waitFor(); await f.page.clock.runFor(50);
      if (mode === "hidden") await f.page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
      await f.page.clock.runFor(65000);
      assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
      assert.ok(f.calls.filter(call => call.path.endsWith("paid")).length <= (mode === "budget" ? 8 : 1));
      assert.ok((await f.page.getByRole("status").allTextContents()).join().includes("accepted work is not cancelled"));
    } finally { await f.close(); }
  }
});
