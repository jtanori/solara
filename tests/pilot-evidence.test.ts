import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { PAID_PROFILE } from "../src/readings/paid-contract";
import { SECTION_MODEL_TIER } from "../src/readings/config";
import { syntheticPaidEvaluation } from "./helpers/paid-evaluation";
import { buildStructures, gateIssuesByLocale, gateVerdicts, inspectReport, pilotEnvComplete, resolveContentVersion, scanPilots, verdictFor } from "../scripts/lib/pilot-evidence";

const TSX = path.resolve("node_modules/.bin/tsx");
const CLI = path.resolve("scripts/pilot-evidence.ts");

/** The fixture report is expensive to build; every case below reads its own copy. */
let cached: ReturnType<typeof syntheticPaidEvaluation> | null = null;
function fixtureReport() {
  cached ??= syntheticPaidEvaluation(PAID_PROFILE);
  return cached;
}

function temp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "pilot-evidence-"));
}

test("a synthetic report fails the editorial gate and is never 'passed' by the inventory", async () => {
  const base = await fixtureReport();
  const evidence = inspectReport(base, "synthetic", null);

  assert.equal(evidence.gate.es, "fail");
  assert.equal(evidence.gate.en, "fail");
  assert.ok(evidence.gateIssues.es.includes("synthetic_is_not_editorial_approval"));
  assert.ok(evidence.reasons.includes("synthetic_source"));
  assert.ok(evidence.reportHash.length === 64);
});

test("without the pilot environment the gate is 'unknown', never 'pass'", async () => {
  const base = await fixtureReport();
  // Every report-side check passes here; only the environment is missing, so the verdict must not
  // become "pass" just because nothing objected.
  const models = { cheap: "deepseek-v4.1-flash", strong: "deepseek-v4-pro" };
  const clean = {
    ...base,
    source: "provider" as const,
    processor: "opencode-console",
    models,
    samples: base.samples.map(sample => ({
      ...sample,
      attempts: sample.attempts.map(attempt => ({
        ...attempt,
        model: models[SECTION_MODEL_TIER[attempt.section]],
        reportedModel: models[SECTION_MODEL_TIER[attempt.section]],
      })),
    })),
  };
  assert.deepEqual(gateIssuesByLocale(clean, null), { es: [], en: [] });
  assert.deepEqual(gateVerdicts(clean, null), { es: "unknown", en: "unknown" });
});

test("the inventory delegates to the gate: a corpus mismatch fails without any environment", async () => {
  const base = await fixtureReport();
  const baseline = base.facts.baseline;
  const foreign = { ...base, facts: { ...base.facts, baseline: { ...baseline, sun: { ...baseline.sun, degree: (baseline.sun.degree + 1) % 30 } } } };
  const issues = gateIssuesByLocale(foreign, null);
  assert.ok(issues.es.includes("approval_binding_changed"), issues.es.join(","));
  assert.equal(gateVerdicts(foreign, null).es, "fail");
});

test("coverage is judged per locale, not per report", async () => {
  const base = await fixtureReport();
  const spanish = { ...base, samples: base.samples.filter(sample => sample.locale === "es") };
  const gate = gateVerdicts(spanish, null);
  const issues = gateIssuesByLocale(spanish, null);
  assert.equal(gate.en, "fail", "the English half has no cases");
  assert.ok(issues.en.includes("approval_corpus_incomplete"));
  assert.ok(!issues.es.includes("approval_corpus_incomplete"), "the Spanish half is complete");
});

test("a report with a different content version is reported as different, not as stale", async () => {
  const base = await fixtureReport();
  const evidence = inspectReport(base, "pilot", "0".repeat(16));
  assert.ok(evidence.reasons.includes("content_version_differs"));
  assert.ok(!evidence.reasons.includes("content_version_stale"));
});

test("a report with fewer than six cases is refused by the gate", async () => {
  const base = await fixtureReport();
  const evidence = inspectReport({ ...base, samples: base.samples.slice(0, 1) }, "pilot", base.contentVersion);
  assert.equal(evidence.gate.es, "fail");
  assert.ok(evidence.reasons.includes("fewer_than_six_cases"));
  assert.ok(evidence.gateIssues.es.includes("approval_corpus_incomplete"));
});

test("an incomplete pilot environment never yields a content version", () => {
  assert.equal(pilotEnvComplete({}), false);
  assert.equal(pilotEnvComplete({ READINGS_PROVIDER: "opencode", READINGS_PROCESSOR_PROFILE: "{}", READINGS_CHEAP_MODEL: "a" }), false, "a blank model is not a model");
  assert.equal(pilotEnvComplete({ READINGS_PROVIDER: "opencode", READINGS_PROCESSOR_PROFILE: "{}", READINGS_CHEAP_MODEL: "a", READINGS_STRONG_MODEL: " " }), false);

  let called = false;
  const absent = resolveContentVersion(null, {}, () => { called = true; return "0".repeat(16); });
  assert.equal(called, false, "the default environment must not be hashed");
  assert.deepEqual({ version: absent.version, source: absent.source }, { version: null, source: "absent" });

  const complete = { READINGS_PROVIDER: "opencode", READINGS_PROCESSOR_PROFILE: "{}", READINGS_CHEAP_MODEL: "a", READINGS_STRONG_MODEL: "b" };
  assert.equal(pilotEnvComplete(complete), true);
  assert.deepEqual(resolveContentVersion(null, complete, () => "a".repeat(16)), {
    version: "a".repeat(16), source: "env", envFingerprint: resolveContentVersion(null, complete, () => "a".repeat(16)).envFingerprint,
  });
  assert.deepEqual(resolveContentVersion("b".repeat(16), complete, () => { throw new Error("must not compute"); }),
    { version: "b".repeat(16), source: "explicit", envFingerprint: resolveContentVersion(null, complete, () => "a".repeat(16)).envFingerprint });
});

test("the CLI refuses to invent a content version and says why", async () => {
  const dir = temp();
  try {
    const base = await fixtureReport();
    mkdirSync(path.join(dir, "pilot"));
    writeFileSync(path.join(dir, "pilot", "report.json"), JSON.stringify(await fixtureReport()));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^READINGS_/.test(key)) delete env[key];
    const result = spawnSync(TSX, [CLI, "--root", dir, "--json"], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /current contentVersion: unknown \(pilot env incomplete; use --content-version\)|"contentVersionSource": "absent"/);
    assert.match(result.stdout, /content_version_unknown/);
    assert.doesNotMatch(result.stdout, /content_version_stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the inventory derives its verdict from one evaluation of the gate", async () => {
  const base = await fixtureReport();
  const evidence = inspectReport(base, "pilot", base.contentVersion, null);
  const issues = gateIssuesByLocale(base, null);
  assert.deepEqual(evidence.gateIssues, issues, "the printed issues are the ones that produced the verdict");
  assert.deepEqual(evidence.gate, verdictFor(issues, null));
  assert.deepEqual(evidence.gate, gateVerdicts(base, null));
});

test("structures keep kinds and lengths, never prose", async () => {
  const base = await fixtureReport();
  const structure = buildStructures([{ pilot: "synthetic", report: base }]);
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
