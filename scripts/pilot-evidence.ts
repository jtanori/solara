#!/usr/bin/env tsx
// pilot-evidence.ts — inventory of the pilot reports on disk (#225).
//
// Read-only: no provider, no database, no prose output. It validates each report, recomputes its
// hash and metrics, derives mechanical blockers, and decides whether it could be approved now.
//
// Usage:
//   npm run readings:pilot-evidence -- [--root .venv/genuine-sampling] [--json]
//                                     [--out <file>] [--content-version <16hex>]
//                                     [--structures <file>]
//
// Exit 0 when every report parsed, 1 when any report was corrupt.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { paidGenerationConfig, type PaidGenerationConfig } from "../src/readings/paid-policy";
import { buildStructures, readReports, resolveContentVersion, scanPilots, writeStructures, type PilotEvidence } from "./lib/pilot-evidence";

type Options = {
  root: string;
  json: boolean;
  out: string;
  contentVersion: string | null;
  structures: string;
  help: boolean;
};

const USAGE = [
  "usage: pilot-evidence [--root .venv/genuine-sampling] [--json] [--out <file>]",
  "                      [--content-version <16hex>] [--structures <file>]",
].join("\n");

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    return index === -1 ? "" : (argv[index + 1] ?? "");
  };
  const explicit = value("--content-version").trim();
  if (explicit !== "" && !/^[a-f0-9]{16}$/.test(explicit)) {
    console.error("ERROR --content-version must be 16 lowercase hex characters");
    process.exit(2);
  }
  return {
    root: value("--root").trim() || ".venv/genuine-sampling",
    json: argv.includes("--json"),
    out: value("--out").trim(),
    contentVersion: explicit === "" ? null : explicit,
    structures: value("--structures").trim(),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function pilotConfig(): PaidGenerationConfig | null {
  try {
    return paidGenerationConfig();
  } catch {
    return null;
  }
}

function mxn(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

function printTable(rows: PilotEvidence[]): void {
  const header = ["pilot", "profile", "loc", "cases", "sections", "measured", "uncertain", "rep", "fail", "p95ms", "hash", "cv", "gate", "reasons"];
  const lines = [header.join("\t")];
  for (const row of rows) {
    lines.push([
      row.pilot,
      row.profile,
      row.locale,
      `${row.cases}`,
      `${row.sectionsGenerated}/${row.sectionsTotal}`,
      mxn(row.measuredMicros),
      mxn(row.uncertainMicros),
      `${row.repairs}`,
      `${row.failedAttempts}`,
      row.p95LatencyMs === null ? "—" : `${row.p95LatencyMs}`,
      row.reportHash.slice(0, 12),
      row.contentVersion,
      `es:${row.gate.es} en:${row.gate.en}`,
      row.reasons.join(","),
    ].join("\t"));
  }
  console.log(lines.join("\n"));
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const resolved = resolveContentVersion(options.contentVersion);
  const current = resolved.version;
  const config = pilotConfig();
  const scan = scanPilots(options.root, current, config);

  if (options.structures) {
    const structure = buildStructures(readReports(options.root));
    writeStructures(options.structures, structure);
    console.log(`wrote ${options.structures} (${structure.cases.length} case structures, ${structure.cases.reduce((sum, row) => sum + row.sections.length, 0)} sections)`);
  }

  const payload = { ...scan, contentVersionSource: resolved.source, envFingerprint: resolved.envFingerprint };
  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, JSON.stringify(payload, null, 2) + "\n");
    console.log(`wrote ${options.out}`);
  }
  for (const error of scan.errors) console.error(`pilot ${error.pilot}: ${error.reason}`);
  if (options.json) console.log(JSON.stringify(payload, null, 2));
  else {
    const source = resolved.source === "explicit" ? "explicit" : resolved.source === "env" ? "from the pilot environment" : "pilot env incomplete; use --content-version";
    console.log(`current contentVersion: ${current ?? "unknown"} (${source})`);
    printTable(scan.pilots);
  }

  if (scan.errors.length > 0) process.exitCode = 1;
  if (scan.pilots.length === 0 && scan.errors.length === 0) {
    console.error(`ERROR no report.json found under ${options.root}`);
    process.exitCode = 1;
  }
}

main();
