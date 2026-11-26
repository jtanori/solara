import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PAID_PROFILE } from "../src/readings/paid-contract";
import { syntheticPaidEvaluation } from "./helpers/paid-evaluation";
import { buildStructures, inspectReport, scanPilots } from "../scripts/lib/pilot-evidence";

const TSX = path.resolve("node_modules/.bin/tsx");
const CLI = path.resolve("scripts/pilot-evidence.ts");

function temp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "pilot-evidence-"));
}

test("a synthetic report is inventoried and never approvable", async () => {
  const report = await syntheticPaidEvaluation(PAID_PROFILE);
  const evidence = inspectReport(report, "synthetic", null);

  assert.equal(evidence.samples, 12);
  assert.equal(evidence.cases, 6);
  assert.equal(evidence.approvable, false);
  assert.ok(evidence.reasons.includes("synthetic_source"));
  assert.ok(evidence.reasons.includes("current_content_version_unavailable"));
  assert.ok(evidence.reportHash.length === 64);
});

test("a synthetic source is refused even when the models are not fixture-named", async () => {
  const report = await syntheticPaidEvaluation(PAID_PROFILE);
  const evidence = inspectReport(
    { ...report, source: "synthetic", processor: "Real-looking processor", models: { cheap: "model-x", strong: "model-y" } },
    "pilot",
    report.contentVersion,
  );
  assert.ok(evidence.reasons.includes("synthetic_source"));
});

test("a provider report with a different content version is stale, not approvable", async () => {
  const report = await syntheticPaidEvaluation(PAID_PROFILE);
  const evidence = inspectReport({ ...report, source: "provider", processor: "Synthetic Test Provider" }, "pilot", "0".repeat(16));
  assert.equal(evidence.approvable, false);
  assert.ok(evidence.reasons.includes("content_version_stale"));
});

test("a report with fewer than six cases is refused by case count", async () => {
  const report = await syntheticPaidEvaluation(PAID_PROFILE);
  const evidence = inspectReport({ ...report, samples: report.samples.slice(0, 1) }, "pilot", report.contentVersion);
  assert.equal(evidence.approvable, false);
  assert.ok(evidence.reasons.includes("fewer_than_six_cases"));
});

test("structures keep kinds and lengths, never prose", async () => {
  const report = await syntheticPaidEvaluation(PAID_PROFILE);
  const structure = buildStructures([{ pilot: "synthetic", report }]);
  assert.equal(structure.version, "pilot-structures/1");
  assert.equal(structure.cases.length, 12);
  const serialized = JSON.stringify(structure);
  assert.doesNotMatch(serialized, /"text":/, "no prose field");
  assert.doesNotMatch(serialized, /"closingQuestion":/, "no question prose");
  for (const row of structure.cases) {
    for (const section of row.sections) {
      assert.ok(typeof section.closingQuestionChars === "number");
      for (const block of section.blocks) {
        assert.ok(typeof block.kind === "string");
        assert.ok(Number.isSafeInteger(block.chars) && block.chars >= 0);
      }
    }
  }
});

test("a corrupt report fails cleanly and makes the scan non-zero", async () => {
  const dir = temp();
  try {
    mkdirSync(path.join(dir, "broken"));
    writeFileSync(path.join(dir, "broken", "report.json"), "{");
    const scan = scanPilots(dir, null);
    assert.equal(scan.pilots.length, 0);
    assert.deepEqual(scan.errors, [{ pilot: "broken", reason: "invalid_json" }]);

    const result = spawnSync(TSX, [CLI, "--root", dir, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pilot broken: invalid_json/);
    assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
