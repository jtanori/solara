import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, pool, coordinationPool } from "../src/db";
import { readings, readingDocuments, readingGenerationRuns as runs, readingGenerationConsents as consents, subscriptions, paidReadingRuns } from "../src/db/schema";
import { AVAILABILITY_COPY } from "../src/readings/presentation-copy";
import { createSession } from "../src/lib/auth";
import { launchReadingTestBrowser } from "../tests/helpers/browser";
import { syntheticReadingAccount, readingLedgerSnapshot } from "../tests/helpers/reading-account";
import { PAID_PROFILES, paidSections } from "../src/readings/paid-contract";
import { syntheticPaidEdition } from "../tests/helpers/paid-edition";
import { inspectPdf } from "../tests/helpers/reading-pdf";

async function main() {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname), "disposable loopback DB only");
  assert.equal(process.env.READINGS_GENERATION_ENABLED, "false", "generation must remain off");
  execFileSync(process.execPath, ["scripts/check-pdf-package.mjs"], { stdio: "inherit" });
  mkdirSync(".venv/reading-browser", { recursive: true });
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "0.0.0.0", resolve));
  const address = reserve.address(); assert.ok(address && typeof address === "object"); const port = address.port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const origin = `http://localhost:${port}`;
  const preload = resolve(".venv/reading-browser/no-server-fetch.cjs");
  writeFileSync(preload, 'globalThis.fetch=async()=>{process.stderr.write("QA_HTTP_BLOCKED\\n");throw new Error("QA network disabled")};');
  const server = spawn(process.execPath, ["--require", preload, "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", String(port)], {
    env: { ...process.env, APP_URL: origin, READINGS_GENERATION_ENABLED: "false", READINGS_API_KEY: "", STRIPE_SECRET_KEY: "", MAIL_TRANSPORT: "outbox", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; const collect = (data: Buffer) => { output = (output + data.toString()).slice(-50000); };
  server.stdout.on("data", collect); server.stderr.on("data", collect);
  const browser = await launchReadingTestBrowser().catch(error => { server.kill("SIGKILL"); throw error; });
  const accounts: Awaited<ReturnType<typeof syntheticReadingAccount>>[] = [];
  const cases: string[] = []; const mutations: string[] = []; const browserErrors: string[] = [];
  async function account(...args: Parameters<typeof syntheticReadingAccount>) { const result = await syntheticReadingAccount(...args); accounts.push(result); return result; }
  async function context(owner: Awaited<ReturnType<typeof account>> | null, locale: "en" | "es", mobile = false) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 }, acceptDownloads: true });
    if (owner) { const session = await createSession(owner.viewer.id); await context.addCookies([{ name: "solara_session", value: session.token, url: origin, httpOnly: true, sameSite: "Lax" }]); }
    await context.addCookies([{ name: "solara_locale", value: locale, url: origin }]);
    // Local app headers/CSP remain intact. Only external UI fonts/assets are
    // blocked; no deployment protection or browser web security is bypassed.
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort("blockedbyclient"));
    const page = await context.newPage();
    const aiReads: string[] = [];
    page.on("pageerror", error => browserErrors.push(error.message));
    page.on("request", req => {
      const path = new URL(req.url()).pathname;
      if (["POST", "PUT"].includes(req.method()) && path.startsWith("/api/readings/")) mutations.push(path);
      if (req.method() === "GET" && (path === "/api/readings/consent" || /^\/api\/readings\/[^/]+\/generation$/.test(path))) aiReads.push(path);
    });
    return { context, page, aiReads };
  }
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(Error("app_start_timeout")), 30000);
      const ready = () => { if (output.includes("Ready in")) { clearTimeout(timer); server.stdout.off("data", ready); resolveReady(); } };
      server.stdout.on("data", ready); ready(); server.once("exit", () => { clearTimeout(timer); reject(Error("app_start_failed")); });
    });
    assert.equal((await fetch(`${origin}/api/ready`)).status, 200);
    const first = await account("es"); const other = await account("en");
    for (const [documentLocale, uiLocale, edition, paid] of [["es", "en", "free", false], ["en", "es", "free", true], ["es", "es", "partial-overview", false], ["en", "en", "partial-sun", false]] as const) {
      console.log(`Checking ${edition}-${documentLocale}/ui-${uiLocale}`);
      const owner = await account(documentLocale, edition);
      if (paid) await db.insert(subscriptions).values({ stripeSubscriptionId: `sub_pdf_${randomUUID()}`, userId: owner.viewer.id, stripeCustomerId: "cus_synthetic_pdf", stripePriceId: "price_synthetic_pdf", currency: "mxn", status: "active", grantsAccess: true, currentPeriodEnd: new Date(Date.now() + 86400000) });
      const { context: ctx, page } = await context(owner, uiLocale, true);
      try {
        const before = await readingLedgerSnapshot(owner.viewer.id);
        const response = await page.goto(`${origin}/reading/${owner.chart.id}`); assert.equal(response?.status(), 200);
        const raw = await response!.text();
        for (const leak of ["fixture-only", "FAILED_PRIVATE", "failureReason", "accounting", "birthDate"]) assert.equal(raw.includes(leak), false, `HTML/RSC leak: ${leak}`);
        const article = page.locator('article[data-edition="saved-reading"]'); await article.waitFor(); assert.equal(await article.getAttribute("lang"), documentLocale);
        assert.equal(await page.locator("[data-locked]").count(), 9); assert.equal(await article.locator("[data-section]").count(), 2);
        assert.equal(await page.getByRole("button", { name: /Generate my free|Generar mi interpretación/ }).count(), 0);
        if (edition === "free") for (const section of owner.document.sections) assert.ok((await article.innerText()).includes(section.closingQuestion!));
        const savedText = await article.innerText();
        const lowContrast = await page.evaluate(String.raw`(() => {
          const root = document.querySelector(".reading-page");
          const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
          const luminance = (value) => rgb(value).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          return [...root.querySelectorAll("p, dt, dd, caption, th, td, li, h1, h2, h3, h4, .tiny-label, .back-link")].filter(element => {
            if (!element.textContent?.trim()) return false;
            const style = getComputedStyle(element); let background = element;
            while (background && getComputedStyle(background).backgroundColor === "rgba(0, 0, 0, 0)") background = background.parentElement;
            const bg = background ? getComputedStyle(background).backgroundColor : "rgb(255,255,255)";
            const a = luminance(style.color); const b = luminance(bg); const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
            const large = parseFloat(style.fontSize) >= 24 || parseFloat(style.fontSize) >= 18.666 && Number(style.fontWeight) >= 700;
            return ratio < (large ? 3 : 4.5);
          }).map(element => element.tagName + "." + element.className);
        })()`);
        assert.deepEqual(lowContrast, [], "reading text meets its normal/large-text contrast threshold");

        for (const table of await article.getByRole("table").all()) {
          const caption = await table.locator("caption").boundingBox(); const headings = await table.locator("thead").boundingBox();
          assert.ok(caption && headings && caption.y + caption.height <= headings.y + 1, "table caption stays above column headers, not an anonymous data cell");
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), true, "390px reading layout fits");
        await page.screenshot({ path: `.venv/reading-browser/${edition}-${documentLocale}-ui-${uiLocale}-mobile.png`, fullPage: true });
        const download = page.locator(`a[href="/api/readings/${owner.chart.id}/pdf?document=${owner.document.id}"]`); await download.focus();
        assert.equal(await download.evaluate(element => element === document.activeElement), true);
        const downloaded = page.waitForEvent("download"); await download.press("Enter"); const artifact = await downloaded; const path = await artifact.path(); assert.ok(path);
        assert.ok(artifact.suggestedFilename().includes(`-${documentLocale}-`));
        const pdf = await inspectPdf(readFileSync(path)); assert.equal(pdf.metadata.Language, documentLocale);
        const direct = await ctx.request.get(`${origin}/api/readings/${owner.chart.id}/pdf?document=${owner.document.id}`); assert.equal(direct.status(), 200); assert.equal(direct.headers()["cache-control"], "private, no-store");
        // Browser zoom changes the layout viewport and physical pixel density;
        // CSS zoom alone does not adjust media-query breakpoints.
        await page.setViewportSize({ width: 682, height: 500 });
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 682, height: 500, deviceScaleFactor: 2, mobile: false });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), true, "200%-equivalent reflow fits");
        await page.screenshot({ path: `.venv/reading-browser/${edition}-${documentLocale}-ui-${uiLocale}-reflow-200.png`, fullPage: true });
        await cdp.send("Emulation.clearDeviceMetricsOverride"); await cdp.detach();
        await page.setViewportSize({ width: 1365, height: 1000 });
        await page.screenshot({ path: `.venv/reading-browser/${edition}-${documentLocale}-ui-${uiLocale}-desktop.png`, fullPage: true });
        const switchedLocale = uiLocale === "en" ? "es" : "en";
        await page.locator('select[name="language"]').selectOption(switchedLocale);
        await page.getByRole("heading", { name: switchedLocale === "es" ? "Tu interpretación con IA" : "Your AI interpretation", exact: true }).waitFor();
        // Read a real authenticated Flight response directly; unrelated Next
        // link-prefetch responses may be canceled by the locale refresh.
        const flightResponse = await ctx.request.get(`${origin}/reading/${owner.chart.id}`, { headers: { RSC: "1" } });
        assert.ok(flightResponse.headers()["content-type"].includes("text/x-component"));
        const flight = await flightResponse.text();
        for (const leak of ["fixture-only", "FAILED_PRIVATE", "failureReason", "accounting", "birthDate"]) assert.equal(flight.includes(leak), false, `RSC navigation leak: ${leak}`);
        assert.equal(await article.innerText(), savedText); assert.equal(await article.getAttribute("data-document-id"), owner.document.id);
        assert.equal((await inspectPdf(await (await ctx.request.get(`${origin}/api/readings/${owner.chart.id}/pdf?document=${owner.document.id}`)).body())).text, pdf.text);
        await page.locator('select[name="language"]').selectOption(uiLocale);
        await page.getByRole("heading", { name: uiLocale === "es" ? "Tu interpretación con IA" : "Your AI interpretation", exact: true }).waitFor();
        await page.locator(`a[href="/reading/${owner.chart.id}?edition=chart"]`).click(); await page.locator('article[data-edition="chart-notes"]').waitFor();
        assert.equal(await page.locator('section[aria-label="AI consent"], section[aria-label="Consentimiento para IA"]').count(), 0, "explicit chart edition must not mount AI controls");
        assert.equal(await page.locator("[data-section]").count(), paid ? 4 : 1);
        assert.ok((await page.locator("body").innerText()).includes(uiLocale === "es" ? "no son una interpretación generada" : "not a generated interpretation"));
        const notesPdf = await inspectPdf(await (await ctx.request.get(`${origin}/api/readings/${owner.chart.id}/pdf?edition=chart`)).body());
        assert.ok(notesPdf.text.includes(uiLocale === "es" ? "no son una interpretación generada" : "not a generated interpretation"));
        const pricing = await ctx.request.get(`${origin}/pricing`); assert.equal(pricing.status(), 200);
        assert.ok((await pricing.text()).includes(uiLocale === "es" ? "Las interpretaciones completas con IA aún no están disponibles" : "Full AI interpretations are not available yet"), "plans do not promise generated paid output");
        const home = await ctx.request.get(origin); assert.equal(home.status(), 200);
        assert.ok((await home.text()).includes(uiLocale === "es" ? "Notas ilustrativas adicionales" : "Additional illustrative notes"));
        if (paid) {
          const accountPage = await ctx.request.get(`${origin}/dashboard`); assert.equal(accountPage.status(), 200);
          assert.ok((await accountPage.text()).includes(uiLocale === "es" ? "La suscripción no desbloquea interpretaciones completas con IA" : "A subscription does not unlock full AI interpretations"));
          await db.update(subscriptions).set({ status: "canceled", grantsAccess: false }).where(eq(subscriptions.userId, owner.viewer.id));
          await page.reload(); await page.locator('article[data-edition="chart-notes"]').waitFor(); assert.equal(await page.locator("[data-section]").count(), 1);
          await page.locator(`a[href="/reading/${owner.chart.id}"]`).click(); await article.waitFor();
          assert.equal(await article.innerText(), savedText);
          assert.equal((await inspectPdf(await (await ctx.request.get(`${origin}/api/readings/${owner.chart.id}/pdf?document=${owner.document.id}`)).body())).text, pdf.text);
        }
        assert.equal(await readingLedgerSnapshot(owner.viewer.id), before, "view/download/locale/plan do not write the generation ledger");
        cases.push(`${edition}-${documentLocale}/ui-${uiLocale}/${paid ? "subscription" : "free"}/mobile+desktop+200%-reflow+locale-navigation+download`);
      } catch (error) { writeFileSync(".venv/reading-browser/failure.html", await page.content()); await page.screenshot({path: ".venv/reading-browser/failure.png", fullPage:true}); throw error; }
      finally { await ctx.close(); }
    }
    // Same immutable paid selection in real Next HTML/RSC, mobile layout, locale
    // navigation and the isolated PDF endpoint; no worker or approval is enabled.
    for (const profile of PAID_PROFILES) for (const locale of ["en", "es"] as const) for (const partial of [false, true]) {
      const owner = await account("en"); const edition = await syntheticPaidEdition(owner, locale, partial, profile);
      const uiLocale = locale === "en" ? "es" : "en";
      const visit = await context(owner, uiLocale, true);
      try {
        const before = await readingLedgerSnapshot(owner.viewer.id);
        const path = `/reading/${owner.chart.id}?paidEdition=${edition.document.id}`;
        assert.equal((await visit.page.goto(`${origin}${path}`))?.status(), 200);
        const article = visit.page.locator(`article[data-document-id="${edition.document.id}"]`); await article.waitFor();
        assert.equal(await article.getAttribute("lang"), locale); assert.equal(await article.locator("[data-section]").count(), paidSections(profile).length);
        assert.equal(await visit.page.locator("[data-locked]").count(), 0);
        assert.equal(await visit.page.getByRole("button", { name: /Generate my free|Generar mi interpretación|Request my paid|Solicitar mi edición/ }).count(), 0);
        await visit.page.getByText(locale === "es" ? "Cálculo guardado de esta edición · Placidus" : "This edition’s saved calculation · Placidus", { exact: true }).click();
        assert.equal(await visit.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), true, "paid fact tables fit at 390px");
        await visit.page.screenshot({ path: `.venv/reading-browser/paid-${profile}-${locale}-${partial ? "partial" : "complete"}.png`, fullPage: true });
        const text = await article.innerText();
        const download = visit.page.locator(`a[href="/api/readings/${owner.chart.id}/pdf?paidEdition=${edition.document.id}"]`);
        const pendingDownload = visit.page.waitForEvent("download"); await download.focus(); await download.press("Enter");
        const artifact = await pendingDownload; const downloaded = await artifact.path(); assert.ok(downloaded);
        const pdf = await inspectPdf(readFileSync(downloaded)); assert.equal(pdf.metadata.Language, locale); assert.ok(pdf.text.includes("Placidus"));
        for (const section of edition.document.sections) assert.ok(pdf.text.includes(section.title));
        await visit.page.locator('select[name="language"]').selectOption(locale);
        await visit.page.getByRole("heading", { name: locale === "es" ? "Tu interpretación con IA" : "Your AI interpretation", exact: true }).waitFor();
        assert.equal(await article.innerText(), text); assert.ok(visit.page.url().includes(`paidEdition=${edition.document.id}`));
        const flight = await (await visit.context.request.get(`${origin}${path}`, { headers: { RSC: "1" } })).text();
        for (const secret of ["fixture-only", "PRIVATE_SYNTHETIC_FAILURE", "birthDate", "policyHash", "accounting"]) assert.equal(flight.includes(secret), false, secret);
        await visit.page.setViewportSize({ width: 682, height: 500 });
        assert.equal(await visit.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), true, "paid facts reflow");
        assert.equal(await readingLedgerSnapshot(owner.viewer.id), before);
        const outsider = await context(other, "en");
        assert.equal((await outsider.context.request.get(`${origin}/api/readings/${owner.chart.id}/pdf?paidEdition=${edition.document.id}`)).status(), 404); await outsider.context.close();
        const loggedOut = await context(null, locale);
        const redirect = await loggedOut.context.request.get(`${origin}${path}`, { maxRedirects: 0 });
        assert.equal(redirect.status(), 307); assert.equal(new URL(redirect.headers().location, origin).searchParams.get("next"), path); await loggedOut.context.close();
        cases.push(`${profile}-${locale}/${partial ? "partial" : "complete"}/pinned-page+RSC+PDF+locale+390px+reflow+foreign-owner+sign-in-return`);
      } finally { await visit.context.close(); }
    }

    // Native timestamp cursor boundaries, exercised through actual client
    // earlier/recent navigation while generation and server fetches remain off.
    for (const locale of ["en", "es"] as const) {
      const owner = await account(locale, "none"); const expected: string[] = [];
      for (let i = 0; i < 21; i++) {
        const saved = await syntheticPaidEdition(owner, locale); expected.push(saved.document.id);
        const at = `2026-01-01 12:00:00.${100900 - i * 10}+00`;
        await db.update(paidReadingRuns).set({ createdAt: sql`${at}::timestamptz` }).where(eq(paidReadingRuns.id, saved.runId));
      }
      const visit = await context(owner, locale);
      try {
        const before = await readingLedgerSnapshot(owner.viewer.id);
        await visit.page.goto(`${origin}/reading/${owner.chart.id}`);
        const section = visit.page.getByRole("region", { name: locale === "es" ? "Ediciones de pago" : "Paid editions", exact: true });
        const links = section.getByRole("link", { name: locale === "es" ? "Abrir esta edición guardada" : "Open this saved edition", exact: true });
        await links.first().waitFor();
        const hrefs = () => links.evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
        const paths = expected.map(id => `/reading/${owner.chart.id}?paidEdition=${id}`);
        assert.deepEqual(await hrefs(), paths.slice(0, 20));
        await section.getByRole("button", { name: locale === "es" ? "Solicitudes anteriores" : "Earlier requests", exact: true }).click();
        await section.locator(`a[href="${paths[20]}"]`).waitFor(); assert.deepEqual(await hrefs(), paths.slice(20));
        await section.getByRole("button", { name: locale === "es" ? "Volver a recientes" : "Back to recent", exact: true }).click();
        await section.locator(`a[href="${paths[0]}"]`).waitFor(); assert.deepEqual(await hrefs(), paths.slice(0, 20));
        assert.equal(await readingLedgerSnapshot(owner.viewer.id), before);
        cases.push(`paid-history-${locale}/microsecond-boundary+earlier+recent+no-writes`);
      } finally { await visit.context.close(); }
    }

    const journeyOwner = await account("en", "none"); const journey = await context(journeyOwner, "en");
    try {
      const before = await readingLedgerSnapshot(journeyOwner.viewer.id);
      await journey.page.goto(`${origin}/pricing?reading=${journeyOwner.chart.id}`);
      assert.equal(await journey.page.getByRole("link", { name: "Return to your saved chart", exact: true }).getAttribute("href"), `/reading/${journeyOwner.chart.id}`);
      assert.ok((await journey.page.locator("body").innerText()).includes("Full AI interpretations are not available yet"));
      await journey.page.goto(`${origin}/dashboard?billing=success&reading=${journeyOwner.chart.id}`);
      await journey.page.getByText("Waiting for verified subscription confirmation. No interpretation has been requested.", { exact: false }).waitFor();
      assert.equal(await journey.page.getByRole("link", { name: "Return to the selected chart", exact: true }).getAttribute("href"), `/reading/${journeyOwner.chart.id}`);
      assert.equal((await journey.context.request.get(`${origin}/pricing?reading=${other.chart.id}`)).status(), 404);
      const forgedDashboard = await journey.context.request.get(`${origin}/dashboard?reading=${other.chart.id}`);
      assert.equal((await forgedDashboard.text()).includes(`href=\"/reading/${other.chart.id}\"`), false);
      const loggedOut = await context(null, "en");
      const redirected = await loggedOut.context.request.get(`${origin}/pricing?reading=${journeyOwner.chart.id}`, { maxRedirects: 0 });
      assert.equal(redirected.status(), 307); assert.equal(new URL(redirected.headers().location, origin).searchParams.get("next"), `/pricing?reading=${journeyOwner.chart.id}`);
      await loggedOut.context.close();
      assert.equal(await readingLedgerSnapshot(journeyOwner.viewer.id), before, "checkout return is neither entitlement, consent nor a generation request");
      cases.push("owned-chart-pricing+sign-in+unverified-checkout-return+no-generation");
    } finally { await journey.context.close(); }

    const anonymous = await context(null, "en");
    assert.equal((await anonymous.context.request.get(`${origin}/api/readings/${first.chart.id}/pdf`)).status(), 401); await anonymous.context.close();
    const foreign = await context(other, "en"); assert.equal((await foreign.page.goto(`${origin}/reading/${first.chart.id}`))?.status(), 404);
    assert.equal((await foreign.context.request.get(`${origin}/api/readings/${first.chart.id}/pdf?document=${first.document.id}`)).status(), 404); await foreign.context.close(); cases.push("unauthenticated+foreign-owner");

    for (const locale of ["en", "es"] as const) for (const scenario of ["history_unavailable", "other_chart"] as const) {
      const owner = await account(locale);
      let chartId = owner.chart.id;
      if (scenario === "history_unavailable") await db.delete(runs).where(eq(runs.userId, owner.viewer.id));
      else {
        const [otherChart] = await db.insert(readings).values({ userId: owner.viewer.id, year: owner.chart.year, input: owner.chart.input, result: owner.chart.result }).returning({ id: readings.id });
        chartId = otherChart.id;
      }
      const before = await readingLedgerSnapshot(owner.viewer.id);
      const visit = await context(owner, locale);
      try {
        assert.equal((await visit.page.goto(`${origin}/reading/${chartId}?edition=chart`))?.status(), 200);
        await visit.page.locator('article[data-edition="chart-notes"]').waitFor();
        await visit.page.waitForLoadState("networkidle");
        assert.equal(await visit.page.locator('section[aria-label="AI consent"], section[aria-label="Consentimiento para IA"]').count(), 0, `${scenario}: explicit chart edition must not mount AI controls`);
        assert.deepEqual(visit.aiReads, [], "explicit chart page must not start consent/status fetches or polling");
        assert.equal(await visit.page.getByRole("button", { name: /Generate my free|Generar mi interpretación/ }).count(), 0);
        const pdfResponse = await visit.context.request.get(`${origin}/api/readings/${chartId}/pdf?edition=chart`);
        assert.equal(pdfResponse.status(), 200);
        assert.ok(pdfResponse.headers()["content-disposition"].endsWith("-chart-notes.pdf\""));
        await visit.page.screenshot({ path: `.venv/reading-browser/chart-readonly-${scenario}-${locale}.png`, fullPage: true });
        await visit.page.locator(`a[href="/reading/${chartId}"]`).click();
        await visit.page.getByText(AVAILABILITY_COPY[scenario][locale], { exact: true }).waitFor();
        if (scenario === "history_unavailable") {
          assert.equal(await visit.page.getByRole("button", { name: /Generate my free|Generar mi interpretación/ }).count(), 0, "canonical history suppression remains in force");
        } else {
          const original = visit.page.getByRole("link", { name: locale === "es" ? "Ir a la carta original →" : "Go to the original chart →", exact: true });
          await original.waitFor();
          assert.equal(await original.getAttribute("href"), `/reading/${owner.chart.id}`);
          await original.click();
          await visit.page.locator(`article[data-document-id="${owner.document.id}"]`).waitFor();
        }
        assert.equal(await readingLedgerSnapshot(owner.viewer.id), before, "edition/canonical/original-chart navigation and PDFs do not write the generation ledger");
        cases.push(`chart-readonly-${scenario}-${locale}/canonical-navigation+download`);
      } finally { await visit.context.close(); }
    }

    const pending = await account("en", "none");
    await db.insert(runs).values({ userId: pending.viewer.id, readingId: pending.chart.id, locale: "en", status: "running", owner: randomUUID(), consumedAt: new Date(), deadline: new Date(Date.now() + 60000), contentVersion: pending.document.contentVersion });
    const live = await context(pending, "en");
    await live.page.goto(`${origin}/reading/${pending.chart.id}`); await live.page.getByRole("status").filter({ hasText: "request is in progress" }).waitFor();
    await db.insert(readingDocuments).values({ id: pending.document.id, readingId: pending.chart.id, locale: "en", tier: "free", contentVersion: pending.document.contentVersion, chartVersion: pending.document.chartVersion, document: pending.document });
    await db.update(runs).set({ documentId: pending.document.id, status: "completed" }).where(eq(runs.userId, pending.viewer.id));
    await live.page.locator(`article[data-document-id="${pending.document.id}"]`).waitFor({ timeout: 15000 }); cases.push("GET-publication-refresh");
    await db.insert(consents).values({ userId: pending.viewer.id, locale: "en", revision: 1, processorId: "synthetic-provider", policyVersion: "synthetic/1", grantedAt: new Date(), policyHash: "a".repeat(64) });
    await live.page.reload(); await live.page.getByRole("button", { name: "Withdraw AI consent", exact: true }).click();
    await live.page.getByRole("button", { name: "Withdraw AI consent", exact: true }).waitFor({ state: "hidden" });
    const withdrawn = await readingLedgerSnapshot(pending.viewer.id); assert.equal((await live.context.request.get(`${origin}/api/readings/${pending.chart.id}/pdf`)).status(), 200);
    assert.equal(await readingLedgerSnapshot(pending.viewer.id), withdrawn); cases.push("withdraw-then-read");
    live.page.once("dialog", dialog => dialog.accept()); await live.page.getByRole("button", { name: "Delete this chart", exact: true }).click(); await live.page.waitForURL(`${origin}/dashboard`);
    assert.equal((await live.context.request.get(`${origin}/api/readings/${pending.chart.id}/pdf?document=${pending.document.id}`)).status(), 404);
    assert.equal((await live.page.goto(`${origin}/reading/${pending.chart.id}`))?.status(), 404);
    const [tombstone] = await db.select().from(runs).where(eq(runs.userId, pending.viewer.id)); assert.equal(tombstone.readingId, null); assert.ok(tombstone.consumedAt); cases.push("delete-navigation-and-no-offer-reset");
    await live.context.close();
    const dashboardOwner = await account("es");
    await db.insert(consents).values({ userId: dashboardOwner.viewer.id, locale: "es", revision: 1, processorId: "synthetic-provider", policyVersion: "synthetic/1", grantedAt: new Date(), policyHash: "a".repeat(64) });
    const dashboard = await context(dashboardOwner, "es"); await dashboard.page.goto(`${origin}/dashboard`);
    const withdrawal = dashboard.page.getByRole("button", { name: "Retirar consentimiento para IA", exact: true });
    await withdrawal.click(); await withdrawal.waitFor({ state: "hidden" });
    const [receipt] = await db.select().from(consents).where(eq(consents.userId, dashboardOwner.viewer.id)); assert.ok(receipt.withdrawnAt);
    await dashboard.context.close(); cases.push("dashboard-withdrawal-no-reading-id-es");
    assert.equal(browserErrors.length, 0, "no unhandled browser/hydration errors");
    assert.equal(mutations.length, 0, "page/download/status/navigation do not POST or PUT");
    assert.equal(output.includes("QA_HTTP_BLOCKED"), false, "zero server provider/HTTP fetches");
    assert.equal(/fixture-only|FAILED_PRIVATE|failureReason/.test(output), false, "no raw private document logs");
    writeFileSync(".venv/reading-browser/result.json", JSON.stringify({ browser: browser.version(), cases, providerFetches: 0, automaticMutations: mutations.length }, null, 2));
    console.log(`Authenticated production-mode reading browser QA: ${cases.length} cases passed; zero provider fetches or automatic POST/PUT.`);
  } finally {
    await browser.close();
    if (server.exitCode === null && server.signalCode === null) { const closed = once(server, "close"); server.kill("SIGTERM"); const kill = setTimeout(() => server.kill("SIGKILL"), 5000); await closed; clearTimeout(kill); }
    writeFileSync(".venv/reading-browser/app.log", output);
    for (const owner of accounts) await owner.cleanup();
    await Promise.all([pool.end(), coordinationPool.end()]);
  }
}
void main().catch(error => { console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Reading browser QA failed"); process.exitCode = 1; });
