#!/usr/bin/env tsx
// render-pilot.ts — render a genuine pilot report through the saved-edition page and PDF (#225).
//
// Local only: disposable loopback database, no provider call. The report's sections are genuine;
// the Placidus snapshot is computed from the corpus input for the same case because the report
// does not carry cusps. Output goes under .venv/pilot-render/ (gitignored) and the command prints
// paths, sizes and hashes only — never prose.
//
// Usage: npx tsx scripts/render-pilot.ts --report <report.json> [--case baseline] [--ui-locale en|es]
//                                         [--out .venv/pilot-render] [--keep]

import { spawnSync } from "node:child_process";
import { fixtureGuard } from "./lib/free-path-guard";
import type { Locale } from "../src/lib/i18n";

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
  console.log("usage: render-pilot --report <report.json> [--case <id>] [--ui-locale en|es] [--out <dir>] [--keep] [--pdf-timeout-ms 60000]");
  process.exit(0);
}

const report = value("--report").trim();
if (!report) fail("--report is required", 2);
const caseId = value("--case").trim() || undefined;
const uiText = value("--ui-locale").trim();
if (uiText && uiText !== "en" && uiText !== "es") fail("--ui-locale must be en or es", 2);
const outDir = value("--out").trim() || ".venv/pilot-render";
const keep = argv.includes("--keep");
const pdfDeadlineMs = Number(value("--pdf-timeout-ms") || 60_000);

async function main(): Promise<void> {
  const guard = fixtureGuard(process.env);
  if (!guard.ok) fail(`refused: ${guard.reason}`, 2);

  const build = spawnSync(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "ignore" });
  if (build.status !== 0) fail("could not build the PDF package (npm run pdf:build)", 2);

  const { renderReport } = await import("./lib/pilot-render");
  try {
    const result = await renderReport({ reportPath: report, caseId, uiLocale: (uiText || undefined) as Locale | undefined, outDir, keep, pdfDeadlineMs });
    console.log(JSON.stringify({
      pilot: result.pilot,
      caseId: result.caseId,
      profile: result.profile,
      locale: result.locale,
      documentId: result.documentId,
      partial: result.partial,
      wheelSystem: result.wheelSystem,
      sections: result.view.content.kind === "saved-reading" ? result.view.content.sections.length : 0,
      html: { path: result.htmlPath, bytes: result.htmlBytes },
      pdf: result.pdfPath ? { path: result.pdfPath, bytes: result.pdfBytes } : { path: null, bytes: 0, error: result.pdfError },
    }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
