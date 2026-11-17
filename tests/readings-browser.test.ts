import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer, type Server } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { build } from "esbuild";
import type { Browser, Page, Route } from "playwright-core";
import { launchReadingTestBrowser } from "./helpers/browser";

const readingId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
let browser: Browser; let server: Server; let origin: string;
before(async () => {
  mkdirSync(".venv/reading-browser", { recursive: true });
  await build({ entryPoints: ["tests/browser/reading-controls.tsx"], outfile: ".venv/reading-browser/controls.js", bundle: true, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "test-next-boundary", setup(b) {
    b.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "test-next" }));
    b.onLoad({ filter: /.*/, namespace: "test-next" }, args => ({ loader: "js", contents: args.path.endsWith("navigation")
      ? "globalThis.readingRefreshes=0;const router={refresh(){globalThis.readingRefreshes++}};export function useRouter(){return router}"
      : "import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}", resolveDir: process.cwd() }));
  } }] });
  const bundle = readFileSync(".venv/reading-browser/controls.js");
  server = createServer((request, response) => {
    if (request.url === "/controls.js") { response.setHeader("Content-Type", "application/javascript"); response.end(bundle); }
    else { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"></head><body><main id="root"></main><script src="/controls.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object"); origin = `http://127.0.0.1:${address.port}`;
  browser = await launchReadingTestBrowser();
});
after(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });
const view = (status: string, id: string | null = null, chart = readingId) => ({ status, readingId: chart, documentId: id, locale: "en" });
const policy = { policyHash: "a".repeat(64), policyVersion: "synthetic/1", disclosure: "Synthetic processor disclosure", providerName: "Synthetic Provider" };
async function fixture(props: Record<string, unknown>, reply: (route: Route, calls: { path: string; method: string }[]) => Promise<void>, nativeTimers = false) {
  const context = await browser.newContext(); const page = await context.newPage();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  if (!nativeTimers) await page.clock.install();
  const calls: { path: string; method: string }[] = [];
  await page.route("**/api/readings/**", async route => {
    const url = new URL(route.request().url()); calls.push({ path: url.pathname, method: route.request().method() }); await reply(route, calls);
  });
  await page.addInitScript(value => { Object.assign(window, { readingProps: value }); }, props);
  await page.goto(origin); if (!nativeTimers) await page.clock.runFor(10);
  return { page, calls, errors, close: () => context.close() };
}
const json = (route: Route, value: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value), headers });
const consent = (active = false) => ({ available: true, active, hasConsent: active, revision: 0, policy });
async function finish(page: Page) { await page.getByRole("button", { name: "Check status", exact: true }).waitFor(); }

for (const locale of ["en", "es"] as const) test(`browser controls: dashboard ${locale} withdrawal has no reading/status dependency`, async () => {
  const f = await fixture({ locale }, async route => json(route, route.request().method() === "DELETE" ? { revision: 1 } : consent(true)));
  try {
    const button = f.page.getByRole("button", { name: locale === "es" ? "Retirar consentimiento para IA" : "Withdraw AI consent", exact: true }); await button.click();
    await button.waitFor({ state: "hidden" });
    assert.deepEqual(f.calls.map(call => call.method), ["GET", "DELETE"]);
    assert.ok(f.calls.every(call => call.path === "/api/readings/consent"));
  } finally { await f.close(); }
});

test("browser controls: explicit keyboard opt-in sends one grant/POST, then GET publication refreshes once", async () => {
  let posted = false;
  const f = await fixture({ readingId, locale: "en" }, async route => {
    if (route.request().method() === "PUT") return json(route, { revision: 1 });
    if (route.request().method() === "POST") { posted = true; return json(route, view("in_progress"), 202, { "Retry-After": "3" }); }
    if (route.request().url().endsWith("consent")) return json(route, consent());
    return json(route, posted ? view("completed", documentId) : view("unused"));
  });
  try {
    const button = f.page.getByRole("button", { name: "Generate my free interpretation", exact: true }); await button.waitFor(); assert.equal(await button.isEnabled(), false);
    const checkbox = f.page.getByRole("checkbox"); await checkbox.focus(); await checkbox.press("Space"); assert.equal(await button.isEnabled(), true); await button.focus(); await button.press("Enter");
    await f.page.getByRole("status").filter({ hasText: "in progress" }).waitFor();
    await f.page.clock.runFor(3100); await finish(f.page);
    assert.equal(await f.page.evaluate(() => (window as unknown as { readingRefreshes: number }).readingRefreshes), 1);
    await f.page.getByRole("button", { name: "Check status", exact: true }).click(); await f.page.clock.runFor(10); await finish(f.page);
    assert.equal(await f.page.evaluate(() => (window as unknown as { readingRefreshes: number }).readingRefreshes), 1);
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1); assert.equal(f.calls.filter(call => call.method === "PUT").length, 1);
    assert.equal(f.calls.filter(call => call.path.endsWith("consent") && call.method === "GET").length, 1);
  } finally { await f.close(); }
});

test("browser controls: lost POST response checks partial status without automatic POST/PUT retry", async () => {
  let posted = false;
  const f = await fixture({ readingId, locale: "en" }, async route => {
    if (route.request().url().endsWith("consent")) return json(route, consent(true));
    if (route.request().method() === "POST") { posted = true; return route.abort("failed"); }
    return json(route, posted ? view("partial", documentId) : view("unused"));
  });
  try {
    await f.page.getByRole("button", { name: "Generate my free interpretation", exact: true }).click(); await f.page.getByRole("alert").waitFor();
    await f.page.clock.runFor(3100); await finish(f.page);
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1); assert.equal(f.calls.filter(call => call.method === "PUT").length, 0);
    assert.equal(await f.page.evaluate(() => (window as unknown as { readingRefreshes: number }).readingRefreshes), 1);
    assert.ok((await f.page.getByRole("status").innerText()).includes("partial"));
  } finally { await f.close(); }
});

test("browser controls: 60-second polling limit, 429 Retry-After and hidden/unmounted sessions never mutate", async () => {
  for (const mode of ["budget", "429", "hidden", "unmount"] as const) {
    const f = await fixture({ readingId, locale: "en" }, async route => route.request().url().endsWith("consent") ? json(route, consent()) : json(route, view("in_progress"), mode === "429" ? 429 : 202, mode === "429" ? { "Retry-After": "600" } : {}));
    try {
      await f.page.getByRole("heading", { name: "Your AI interpretation" }).waitFor(); await f.page.clock.runFor(100);
      if (mode === "hidden") await f.page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
      if (mode === "unmount") await f.page.evaluate(() => (window as unknown as { mountReadingControls: (props: object) => void }).mountReadingControls({ locale: "es" }));
      await f.page.clock.runFor(mode === "429" ? 300000 : 65000);
      assert.equal(f.calls.filter(call => ["POST", "PUT", "DELETE"].includes(call.method)).length, 0);
      const gets = f.calls.filter(call => call.path.endsWith("generation"));
      assert.ok(gets.length <= (mode === "budget" ? 8 : 1));
      if (mode === "429") assert.equal(await f.page.getByRole("button", { name: "Check status", exact: true }).isEnabled(), false);
      if (mode === "hidden" || mode === "budget") assert.ok((await f.page.getByRole("status").allTextContents()).join().includes("Automatic status checks stopped"));
    } finally { await f.close(); }
  }
});

test("browser controls: stale old-chart response cannot refresh or overwrite a new locale/chart", async () => {
  let stale: Route | undefined;
  let started!: () => void; const initial = new Promise<void>(resolve => { started = resolve; });
  const other = "77777777-7777-4777-8777-777777777777";
  const f = await fixture({ readingId, locale: "en" }, async route => {
    if (route.request().url().endsWith("consent")) return json(route, consent());
    if (route.request().url().includes(readingId)) { stale = route; started(); return; }
    return json(route, { ...view("completed", documentId, other), locale: "es" });
  });
  try {
    await initial;
    await f.page.evaluate(id => (window as unknown as { mountReadingControls: (props: object) => void }).mountReadingControls({ readingId: id, locale: "es" }), other);
    await f.page.clock.runFor(20);
    await f.page.getByRole("button", { name: "Consultar estado", exact: true }).waitFor();
    if (stale) await json(stale, view("completed", "88888888-8888-4888-8888-888888888888")).catch(() => undefined);
    await f.page.clock.runFor(65000);
    assert.equal(await f.page.evaluate(() => (window as unknown as { readingRefreshes: number }).readingRefreshes), 1);
    assert.equal(await f.page.getByRole("heading", { name: "Tu interpretación con IA" }).isVisible(), true);
    assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
  } finally { await f.close(); }
});

test("browser controls: unavailable history never offers or labels the offer unused", async () => {
  const f = await fixture({ readingId, locale: "en", allowGeneration: false }, async route => json(route, route.request().url().endsWith("consent") ? consent() : view("unused")));
  try {
    await finish(f.page);
    assert.equal(await f.page.getByRole("button", { name: "Generate my free interpretation", exact: true }).count(), 0);
    assert.equal((await f.page.locator("body").innerText()).includes("has not been used"), false);
  } finally { await f.close(); }
});

test("browser controls: a generate 429 honors its delay even when longer than the polling budget", async () => {
  const f = await fixture({ readingId, locale: "en" }, async route => {
    if (route.request().url().endsWith("consent")) return json(route, consent(true));
    if (route.request().method() === "POST") return json(route, { code: "rate_limited" }, 429, { "Retry-After": "600" });
    return json(route, view("unused"));
  });
  try {
    await f.page.getByRole("button", { name: "Generate my free interpretation", exact: true }).click(); await f.page.getByRole("alert").waitFor();
    await f.page.clock.runFor(300000);
    assert.equal(f.calls.filter(call => call.path.endsWith("generation")).length, 1);
    assert.equal(await f.page.getByRole("button", { name: "Check status", exact: true }).isEnabled(), false);
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  } finally { await f.close(); }
});


test("browser controls: native Window timers work without fake-clock binding leniency", async () => {
  const f = await fixture({ readingId, locale: "en" }, async route => json(route, route.request().url().endsWith("consent") ? consent() : view("unused")), true);
  try {
    if (!f.errors.length) await Promise.race([finish(f.page), f.page.waitForEvent("pageerror")]);
    assert.deepEqual(f.errors, [], "native timers never throw Illegal invocation");
    assert.equal(await f.page.getByRole("heading", { name: "Your AI interpretation" }).isVisible(), true);
    assert.equal(f.calls.filter(call => call.path.endsWith("generation")).length, 1);
  } finally { await f.close(); }
});
