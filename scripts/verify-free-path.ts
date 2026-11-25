#!/usr/bin/env tsx
// verify-free-path.ts — the free-reading journey on a disposable database (#226).
//
// Fixture mode is free and local: six synthetic charts, one verified account each, real save →
// explicit consent → explicit generation → persisted document. Real-provider mode is the same
// journey with the real adapter, and it requires --authorize-real plus a spend cap; it never runs
// in CI.
//
// The report prints ids, statuses, section keys, versions and hashes — never prose, never a
// birth input, never a secret.
//
// Usage:
//   npm run readings:free-path -- [--locales es|en|es,en] [--out <file>] [--keep]
//   npm run readings:free-path -- --real-provider --authorize-real --max-spend-mxn 30
//
// Exit 0 all cases completed, 1 any failed/partial, 2 guard or usage error.

import { writeFileSync } from "node:fs";
import { TIER_CEILING_MXN } from "../src/readings/config";
import { liveGenerationConfig } from "../src/readings/policy";
import { loadChartCorpus } from "./lib/chart-corpus";
import { fixtureGuard, realProviderGuard } from "./lib/free-path-guard";
import type { Locale } from "../src/lib/i18n";
import type { FreePathReport } from "./lib/free-path";

type Options = {
  locales: Locale[];
  out: string;
  keep: boolean;
  real: boolean;
  authorize: boolean;
  maxSpendMxn: number;
  help: boolean;
};

const USAGE = [
  "usage: verify-free-path [--locales es|en|es,en] [--out <file>] [--keep]",
  "                        [--real-provider --authorize-real --max-spend-mxn <n>]",
].join("\n");

function usage(exitCode: 0 | 2): never {
  if (exitCode === 0) console.log(USAGE);
  else console.error(USAGE);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    return index === -1 ? "" : (argv[index + 1] ?? "");
  };
  const rawLocales = value("--locales") || "es";
  const locales = rawLocales.split(",").map(part => part.trim()).filter(Boolean);
  if (locales.length === 0 || locales.some(locale => locale !== "es" && locale !== "en")) usage(2);
  const maxSpend = value("--max-spend-mxn");
  if (maxSpend !== "" && !/^[0-9]+(\.[0-9]+)?$/.test(maxSpend)) usage(2);
  return {
    locales: [...new Set(locales)] as Locale[],
    out: value("--out"),
    keep: argv.includes("--keep"),
    real: argv.includes("--real-provider"),
    authorize: argv.includes("--authorize-real"),
    maxSpendMxn: maxSpend === "" ? 0 : Number(maxSpend),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage(0);

  const corpus = loadChartCorpus();
  const totalCases = corpus.length * options.locales.length;

  if (options.real) {
    const guard = realProviderGuard(process.env, {
      authorized: options.authorize,
      maxSpendMxn: options.maxSpendMxn,
      cases: totalCases,
      ceilingMxn: TIER_CEILING_MXN.free,
    });
    if (!guard.ok) {
      console.error(`refused: ${guard.reason}`);
      process.exit(2);
    }
    const config = liveGenerationConfig();
    if (!config) {
      console.error("refused: real-provider mode requires READINGS_API_KEY, a profile, models and prices");
      process.exit(2);
    }
    const { runFreePathJourney } = await import("./lib/free-path");
    const report = await runFreePathJourney({
      corpus,
      locales: options.locales,
      configFor: () => config,
      mode: "real",
      keep: options.keep,
    });
    emit(report, options.out);
    return;
  }

  const guard = fixtureGuard(process.env);
  if (!guard.ok) {
    console.error(`refused: ${guard.reason}`);
    process.exit(2);
  }

  // Imported after the guard so a hosted database never loads `src/db`.
  const { fixtureConfig, fixtureFetch, runFreePathJourney } = await import("./lib/free-path");
  const report = await runFreePathJourney({
    corpus,
    locales: options.locales,
    configFor: () => fixtureConfig(fixtureFetch()),
    mode: "fixture",
    keep: options.keep,
    onCase: (id, locale) => console.error(`case ${id}/${locale}`),
  });
  emit(report, options.out);
}

function emit(report: FreePathReport, out: string): void {
  const json = JSON.stringify(report, null, 2);
  if (out) {
    writeFileSync(out, json + "\n");
    console.log(`wrote ${out}`);
    console.log(JSON.stringify({ mode: report.mode, summary: report.summary }));
  } else {
    console.log(json);
  }
  if (report.summary.failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(`free path harness failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
