import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Deliberately destructive TEST runner. A committed clean checkpoint, explicit
// loopback test DB and disabled generation are mandatory. Sources are restored
// after EACH mutation, even when a test survives or the child times out. Never
// edit expectations or accept transform/import/timeouts as assertion kills.
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL).hostname), "disposable loopback database only");
assert.equal(process.env.READINGS_GENERATION_ENABLED, "false");
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "commit a clean checkpoint before mutation testing");
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const env = { ...process.env, READINGS_GENERATION_ENABLED: "false", RUN_INTEGRATION_TESTS: "1", RUN_BILLING_INTEGRATION_TESTS: "1", NEXT_TELEMETRY_DISABLED: "1", APP_URL: "http://localhost:3000" };
const change = (path, from, to, count = 1) => ({ path, from, to, count });
const foundation = ["tests/readings-presentation.test.ts", "tests/readings-view.test.ts"];
const pdf = ["tests/pdf.test.ts"], http = ["tests/readings-page.test.ts"], html = ["tests/readings-renderer.test.ts"], polling = ["tests/readings-controls.test.ts"], browser = ["tests/readings-browser.test.ts"];
const view = "src/readings/reading-view.ts", decoder = "src/readings/stored-document.ts", catalog = "src/readings/presentation-copy.ts", render = "src/readings/pdf-render.ts", component = "src/components/solar-pdf.tsx", controls = "src/components/reading-generation-controls.tsx", scheduler = "src/readings/status-polling.ts", handler = "src/readings/pdf-http.ts";
const mutation = (name, changes, tests, pattern) => ({ name, changes, tests, pattern });
const mutations = [
  mutation("owner-scope", [change(view, '.where(and(eq(readings.id, readingId), eq(readings.userId, userId))).limit(1)', '.where(eq(readings.id, readingId)).limit(1)', 2)], foundation),
  mutation("pinned-identity", [change(view, 'if (selector.kind === "document" && (run?.readingId !== chart.id || run.documentId !== selector.id || !document))', 'if (false && selector.kind === "document" && (run?.readingId !== chart.id || run.documentId !== selector.id || !document))')], http, "authenticated selectors"),
  mutation("run-locale", [change(view, "run.locale === document.locale && ", "")], foundation),
  mutation("run-version", [change(view, "run.contentVersion === document.contentVersion && ", "")], foundation),
  mutation("published-state", [change(view, '["completed", "partial", "legacy"].includes(run.status)', "true")], foundation),
  mutation("sql-byte-bound", [change(view, "octet_length(${documents.document}::text) <= ${READING_LIMITS.documentBytes}", "true")], foundation),
  mutation("reader-network-dispatch", [change(view, "const store = deps.store ?? new ReadingViewStore();", 'const store = deps.store ?? new ReadingViewStore(); await fetch("https://must-not-be-called.invalid");')], foundation),
  mutation("free-paid-key", [change(decoder, '(document.tier === "free" && (source.key !== "overview" && source.key !== "sun"))', "false")], foundation),
  mutation("duplicate-section", [change(decoder, "seen.has(source.key) || ", "")], foundation),
  mutation("row-envelope-identity", [change(decoder, "if (document[key] !== expectedIdentity.data[key])", "if (false && document[key] !== expectedIdentity.data[key])")], foundation),
  mutation("closing-question", [change(decoder, "section.closingQuestion = question.data", "section.closingQuestion = undefined")], foundation),
  mutation("unknown-payload", [change(decoder, 'if (!knownKinds.has(kind.data.kind)) { unsupported = true; continue; }', 'if (!knownKinds.has(kind.data.kind)) { unsupported = true; section.blocks.push({ kind: "prose", text: "DO_NOT_RENDER" }); continue; }')], foundation),
  mutation("raw-metadata", [change(decoder, "return { ok: true, value: {\n    kind:", "return { ok: true, value: {\n    ...(raw as Record<string, unknown>), kind:")], http, "canonical saved locale"),
  mutation("decoder-byte-bound", [change(decoder, 'if (Buffer.byteLength(serialized, "utf8") > READING_LIMITS.documentBytes)', 'if (false && Buffer.byteLength(serialized, "utf8") > READING_LIMITS.documentBytes)')], foundation),
  mutation("aggregate-text-bound", [change(decoder, "if (textLength > (document.tier", "if (false && textLength > (document.tier")], foundation),
  mutation("planned-preview", [change(catalog, 'sectionDefinition(key).requiresFacts ? "planned" : "not_included"', 'false ? "planned" : "not_included"')], foundation),
  mutation("expired-status", [change("src/readings/generation-view.ts", "run.expired || !run.owner", "!run.owner")], foundation),
  mutation("ui-locale-overrides-saved", [change(view, 'content: decoded.value, generation, availability: "ready"', 'content: { ...decoded.value, locale }, generation, availability: "ready"')], http, "canonical saved locale"),
  mutation("newest-row-substitution", [change(view, '.leftJoin(documents, and(eq(documents.id, runs.documentId),', '.leftJoin(documents, and(eq(documents.id, sql`(select chosen.id from reading_documents chosen where chosen.reading_id = ${readings.id} order by chosen.created_at desc limit 1)`),')], foundation),
  mutation("paid-provider-dispatch", [change("src/readings/generate.ts", "const wanted = sectionsForTier(args.tier)", 'const wanted = sectionsForTier("paid")')], ["tests/readings-pipeline.test.ts"], "document: free tier shape"),
  mutation("subscription-selects-paid", [change(view, 'document.tier === "free";', '(document.tier === "free" || user.plan === "paid");'), change(view, '{ legacy: run.status === "legacy" }', '{ legacy: run.status === "legacy", allowPaid: user.plan === "paid" }')], foundation),
  mutation("pdf-link-unpinned", [change("src/components/reading-page-view.tsx", 'pdf?${readingEditionQuery(content)}', "pdf")], html, "PDF identity stays pinned"),
  mutation("pdf-question-dropped", [change(component, "if (section.closingQuestion) narrative.push", "if (false && section.closingQuestion) narrative.push")], pdf, "PDF: frozen free-en"),
  mutation("pdf-sections-reversed", [change(component, "content.sections.forEach(renderSection)", "[...content.sections].reverse().forEach(renderSection)")], pdf, "PDF: frozen free-en"),
  mutation("pdf-rows-reversed", [change(component, "const rows = block.rows.flatMap", "const rows = [...block.rows].reverse().flatMap")], pdf, "PDF: long prose"),
  mutation("pdf-orb-dropped", [change(component, '`${row.orb}°`', '""')], pdf, "PDF: frozen free-en"),
  mutation("pdf-accent-dropped", [change(component, 'pdfLines(value, width, size, renderer, bold).join("\\n")', 'pdfLines(value.replaceAll("ñ", "n"), width, size, renderer, bold).join("\\n")')], pdf, "PDF: frozen free-es"),
  mutation("pdf-callout-dropped", [change(component, "{wrap(block.text, 475, 9)}", '{""}')], pdf, "PDF: frozen free-en"),
  mutation("failed-private-prose", [change(decoder, "section.blocks = failureFacts(source.key, source.facts, document.locale);", 'section.blocks = [{ kind: "prose", text: "PRIVATE_FAILURE_SENTINEL" }];')], html, "failed content and internals"),
  mutation("raw-error-logs", [change(handler, '{ ...requestMeta(request), code }', '{ ...requestMeta(request), code, description: error instanceof Error ? error.message : "error" }')], http, "safe render/DB errors"),
  mutation("unknown-drops-sibling", [change(decoder, 'if (!knownKinds.has(kind.data.kind)) { unsupported = true; continue; }', 'if (!knownKinds.has(kind.data.kind)) { unsupported = true; section.blocks = []; break; }')], pdf, "PDF: unknown payload"),
  mutation("polling-post", [change(scheduler, '{ method: "GET", cache: "no-store", signal: controller.signal }', '{ method: "POST", cache: "no-store", signal: controller.signal }')], polling, "unused/terminal"),
  mutation("consent-grant-on-mount", [change(controls, 'fetch("/api/readings/consent", { method: "GET",', 'fetch("/api/readings/consent", { method: "PUT",')], browser, "dashboard en withdrawal"),
  mutation("lost-post-retry", [change(controls, "// No lost-response POST/PUT retry. Only a new finite GET session.", 'await fetch(`/api/readings/${readingId}/generate`, { method: "POST" }).catch(() => undefined);')], browser, "lost POST response"),
  mutation("polling-time-budget", [change(scheduler, "durationMs: 60_000", "durationMs: 600_000")], polling, "3/6/10 second"),
  mutation("polling-request-budget", [change(scheduler, "count >= STATUS_POLL_LIMITS.requests", "false", 2)], polling, "hard request cap"),
  mutation("refresh-identity-guard", [change(scheduler, " || seen.has(view.documentId)", "")], polling, "refresh: once"),
  mutation("native-timer-binding", [change(scheduler, "later: (action, ms) => setTimeout(action, ms), cancel: timer => clearTimeout(timer)", "later: setTimeout, cancel: clearTimeout")], browser, "native Window timers"),
  mutation("private-cache-header", [change(handler, "for (const { key, value } of [...authenticatedCacheHeaders, ...privateReferrerHeaders])", "for (const { key, value } of [...privateReferrerHeaders])")], http, "authenticated selectors"),
  mutation("final-ownership-check", [change(handler, "if (!await store.stillOwned", "if (false && !await store.stillOwned")], http, "deletion/replacement during render"),
  mutation("parent-input-cap", [change(render, "if (Buffer.byteLength(serialized) >", "if (false && Buffer.byteLength(serialized) >"), change(render, 'textLength > (input.content.kind === "saved-reading"', 'false && textLength > (input.content.kind === "saved-reading"')], pdf, "oversized input"),
  mutation("parent-output-cap", [change(render, "bytes > limits.outputBytes || ", "")], pdf, "output/memory/deadline caps"),
  mutation("concurrency-cap", [change(render, 'if (this.active) throw new ReadingPdfError("pdf_capacity");', "")], pdf, "abort and concurrent saturation"),
  mutation("early-slot-release", [change(render, "error ??= code;", "error ??= code; this.active = false;")], pdf, "abort and concurrent saturation"),
  mutation("promise-only-cancel", [change(render, 'child.kill("SIGKILL");', "// Mutant: do not kill the actual render process.")], pdf, "abort and concurrent saturation"),
  mutation("external-rss-cap", [change(render, 'if (rss > limits.rssBytes) terminate("pdf_memory_limit");', "")], pdf, "parent RSS monitoring"),
  mutation("notes-as-generated-premium", [change(catalog, '"Carta y notas ilustrativas" : "Chart and illustrative notes"', '"TU LECTURA PREMIUM" : "YOUR PREMIUM READING"')], pdf, "long legacy notes"),
  mutation("mutable-notes-substitution", [change(view, 'if (decoded?.ok) return { chart, content: decoded.value, generation, availability: "ready" };', 'if (decoded?.ok) return { chart, content: chartNotes(chart, await (deps.notes ?? getReadingNotes)(chart.result, locale), locale, user.plan === "paid"), generation, availability: "ready" };')], pdf, "actual canonical reads stay frozen"),
  mutation("section-heading-orphan", [change(component, 'minPresenceAhead={section.blocks[0]?.kind === "aspectTable" ? 300 : 90}', 'minPresenceAhead={0}')], pdf, "PDF: frozen paid-es"),
  mutation("table-heading-orphan", [change(component, "if (index === 0) narrative.splice(beforeHeading);", "")], pdf, "leading long tables"),
  mutation("section-heading-overflow", [change(component, "if (headingHeight > PDF_FIXED_LAYOUT_LIMITS.sectionHeadingPt)", "if (false && headingHeight > PDF_FIXED_LAYOUT_LIMITS.sectionHeadingPt)")], pdf, "multiline section titles"),
  mutation("table-title-overflow", [change(component, "if (!inline && repeatedTitle.length > PDF_FIXED_LAYOUT_LIMITS.tableTitleLines)", "if (false && !inline && repeatedTitle.length > PDF_FIXED_LAYOUT_LIMITS.tableTitleLines)")], pdf, "oversized repeated table headings"),
  { ...mutation("premium-plans-promise", [change("src/app/pricing/page.tsx", "Full AI interpretations are not available yet; a subscription does not unlock them.", "Premium unlocks all nine generated topics now.")], []), builtBrowser: true },
  { ...mutation("raw-client-rsc-prop", [change("src/app/reading/[id]/page.tsx", "controls={<ReadingGenerationControls key=", 'controls={<ReadingGenerationControls {...{ rawDocument: { models: { overview: "fixture-only" } } }} key=')], []), builtBrowser: true },
];
const selected = process.argv.find(argument => argument.startsWith("--only="))?.slice(7);
assert.ok(!selected || mutations.some(mutation => mutation.name === selected), "unknown mutation name");
const folder = ".venv/reading-mutations"; mkdirSync(`${folder}/backups`, { recursive: true });
const originals = new Map([...new Set([...mutations.flatMap(mutation => mutation.changes.map(change => change.path)), "next-env.d.ts"])].map(path => [path, readFileSync(path)]));
for (const [path, bytes] of originals) writeFileSync(`${folder}/backups/${path.replaceAll("/", "__")}`, bytes);
const evidence = { sourceSha, originals: Object.fromEntries([...originals].map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")])), mutations: [], restored: false, cleanRerun: false };
let active; let interrupted = false;
const interrupt = () => { interrupted = true; if (active?.pid) { try { process.kill(-active.pid, "SIGKILL"); } catch { /* Child already exited. */ } } };
process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
async function run(label, args, timeoutMs = 120000) {
  const output = [];
  let timedOut = false;
  const child = spawn(args[0], args.slice(1), { env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); active = child;
  child.stdout.on("data", chunk => output.push(chunk)); child.stderr.on("data", chunk => output.push(chunk));
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }, timeoutMs);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }); }
  finally { clearTimeout(timer); active = undefined; }
  const text = Buffer.concat(output).toString(); writeFileSync(`${folder}/${label}.log`, text);
  if (interrupted || timedOut) throw Error(`${label}: interrupted/timeout, not an assertion kill`);
  return { code, text };
}
const commandFor = mutation => [process.execPath, "--import", "tsx", "--test", ...(mutation.pattern ? [`--test-name-pattern=${mutation.pattern}`] : []), ...mutation.tests];
const restore = () => { for (const [path, original] of originals) writeFileSync(path, original); };
try {
  for (const mutant of mutations.filter(mutation => !selected || mutation.name === selected)) {
    try {
      for (const { path, from, to, count } of mutant.changes) {
        const source = readFileSync(path, "utf8"); assert.equal(source.split(from).length - 1, count, `mutation target drift: ${mutant.name}`);
        writeFileSync(path, source.replaceAll(from, to));
      }
      if (mutant.builtBrowser) {
        const build = await run(`${mutant.name}-build`, ["npm", "run", "build"], 180000);
        assert.equal(build.code, 0, "a build failure is NOT a caught RSC leak");
      }
      const command = mutant.builtBrowser ? [process.execPath, "--import", "tsx", "scripts/verify-reading-browser.ts"] : commandFor(mutant);
      const result = await run(mutant.name, command);
      const caught = result.code !== 0 && /ERR_ASSERTION|AssertionError/.test(result.text) && !/TransformError|SyntaxError|ERR_MODULE_NOT_FOUND/.test(result.text);
      evidence.mutations.push({ name: mutant.name, changes: mutant.changes, command, caught, failures: result.text.split("\n").filter(line => /^not ok |AssertionError|error: /.test(line)).slice(0, 15) });
      console.log(`${mutant.name}: ${caught ? "ASSERTION KILL" : "NOT CAUGHT"}`);
      assert.ok(caught, `${mutant.name}: must fail an assertion; see its log`);
    } finally { restore(); }
  }
} finally {
  restore(); evidence.restored = [...originals].every(([path, original]) => readFileSync(path).equals(original));
  writeFileSync(`${folder}/result.json`, JSON.stringify(evidence, null, 2) + "\n");
  // An interrupted run must not leave a deployed-looking mutant PDF bundle.
  execFileSync(process.execPath, ["scripts/build-pdf.mjs"], { env, stdio: "inherit" });
}
const restoredTests = await run("restored-tests", [process.execPath, "--import", "tsx", "--test", ...new Set(mutations.flatMap(mutation => mutation.tests))], 180000);
assert.equal(restoredTests.code, 0, "unmutated scoped suite must pass after restoration");
const restoredBuild = await run("restored-build", ["npm", "run", "build"], 180000);
restore(); assert.equal(restoredBuild.code, 0, "restored production build must pass");
const restoredBrowser = await run("restored-browser", [process.execPath, "--import", "tsx", "scripts/verify-reading-browser.ts"]);
assert.equal(restoredBrowser.code, 0, "restored authenticated browser checks must pass");
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "sources/expectations restored without incidental churn");
evidence.cleanRerun = true; writeFileSync(`${folder}/result.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log(`${evidence.mutations.length}/${selected ? 1 : mutations.length} assertion-killed mutants; all sources restored and scoped tests/build/authenticated browser rerun green @ ${sourceSha}.`);
