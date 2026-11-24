import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_OUTPUT_TOKENS_PER_SECTION, SECTION_MODEL_TIER } from "../src/readings/config";
import { costMicros } from "../src/readings/execution";
import { evaluationSampleChecks } from "../src/readings/evaluation";
import { PAID_SECTION_TITLES } from "../src/readings/copy";
import { PAID_CORE_SECTIONS, PAID_PROFILE, PAID_RICH_PROFILE, PAID_RICH_SECTIONS, type PaidProfile } from "../src/readings/paid-contract";
import type { PaidGenerationConfig } from "../src/readings/paid-policy";
import { canonicalHash } from "../src/readings/policy";
import { createFixtureProvider, type Completion, type CompletionRequest, type ReadingProvider } from "../src/readings/provider";
import { runGenuineSampling, SamplingError, type SamplingCorpus, type SamplingOptions } from "../src/readings/sampling";
import { parseSamplingOptions } from "../src/readings/sampling-options";
import { loadPaidEvaluationCorpus } from "../scripts/lib/paid-evaluation-corpus";

/*
 * Zero-cost coverage for S2-a (#103): the CLI contract, the file ledger and the
 * orchestration. No test calls a provider, reads a real key or touches a
 * database. The fake provider quotes the full input bound, so the durable ledger
 * path is exercised exactly as the real chat adapter uses it.
 */

const fixture = createFixtureProvider();
const upper = { inputTokens: 1_000, outputTokens: MAX_OUTPUT_TOKENS_PER_SECTION };
const settings = {
  models: { cheap: "test-cheap", strong: "test-strong" },
  prices: {
    "test-cheap": { inputMxnPerMillion: 10, outputMxnPerMillion: 20 },
    "test-strong": { inputMxnPerMillion: 30, outputMxnPerMillion: 60 },
  },
};
const quotes = {
  "test-cheap": costMicros(settings.prices, "test-cheap", upper)!,
  "test-strong": costMicros(settings.prices, "test-strong", upper)!,
};
const coreCorpus = loadPaidEvaluationCorpus(PAID_PROFILE);
const richCorpus = loadPaidEvaluationCorpus(PAID_RICH_PROFILE);

function errorCode(run: () => unknown) {
  try {
    run();
    return "no-error";
  } catch (error) {
    return error instanceof SamplingError ? error.code : "other";
  }
}

function configFor(profile: PaidProfile, provider: ReadingProvider): PaidGenerationConfig {
  const config: PaidGenerationConfig = {
    profile: {
      id: "test-processor",
      name: "Test Processor",
      policyVersion: "v1",
      inputTokenLimits: { "test-cheap": upper.inputTokens, "test-strong": upper.inputTokens },
      servedModels: { "test-cheap": ["test-cheap"], "test-strong": ["test-strong"] },
      baseUrl: "https://test.invalid/v1",
      policyHash: "a".repeat(64),
      payloadPolicy: profile === PAID_RICH_PROFILE ? "derived-chart-annual-v2" : "derived-chart-v1",
    },
    settings,
    provider,
    fingerprint: "b".repeat(64),
    quotes,
    editionProfile: profile,
    sections: profile === PAID_RICH_PROFILE ? [...PAID_RICH_SECTIONS] : [...PAID_CORE_SECTIONS],
    contentVersion: "cv-test",
  };
  return config;
}

function providerFor(reply: (request: CompletionRequest, call: number) => Promise<Completion> | Completion) {
  const calls: CompletionRequest[] = [];
  const provider: ReadingProvider = {
    name: "test-provider",
    prepare(request) {
      return {
        upperUsage: upper,
        send: async () => {
          calls.push(request);
          const value = await reply(request, calls.length);
          return { ...value, usage: { inputTokens: 10, outputTokens: 20 }, latencyMs: 5 };
        },
      };
    },
    async complete() {
      throw new Error("durable sampling must use prepare");
    },
  };
  return { provider, calls };
}

function options(dir: string, overrides: Partial<SamplingOptions> = {}): SamplingOptions {
  return {
    outputDir: dir,
    pilot: "pilot-test",
    profile: PAID_PROFILE,
    locale: "es",
    cases: ["baseline"],
    capMicros: 10_000_000,
    ...overrides,
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "solara-sampling-"));
}

function ledgerRecords(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}

function writeLedger(dir: string, records: Array<Record<string, unknown>>) {
  writeFileSync(join(dir, "ledger.jsonl"), `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

test("sampling CLI: refuses without explicit authorization, cap, case list or profile agreement", () => {
  const base = ["--pilot", "pilot-test", "--profile", "paid-core-v1", "--cases", "baseline", "--max-spend-mxn", "10"];

  assert.equal(errorCode(() => parseSamplingOptions(base, {})), "sampling_authorization_missing");
  assert.equal(errorCode(() => parseSamplingOptions([...base, "--authorize-pilot"], { VERCEL: "1" })), "sampling_authorization_missing");
  assert.equal(errorCode(() => parseSamplingOptions([...base, "--authorize-pilot", "--bogus"], {})), "sampling_authorization_missing");
  assert.equal(errorCode(() => parseSamplingOptions(["--pilot", "pilot-test", "--authorize-pilot"], {})), "sampling_authorization_missing");
  assert.equal(errorCode(() => parseSamplingOptions(["--pilot", "pilot-test", "--cases", "baseline", "--max-spend-mxn", "21", "--authorize-pilot"], {})), "sampling_cap_invalid");
  assert.equal(errorCode(() => parseSamplingOptions(["--pilot", "pilot-test", "--cases", "baseline", "--max-spend-mxn", "20", "--authorize-pilot"], {})), "sampling_cap_invalid");
  assert.equal(errorCode(() => parseSamplingOptions([...base, "--authorize-pilot"], { READINGS_PAID_PROFILE: "paid-rich-v1" })), "sampling_profile_mismatch");

  const parsed = parseSamplingOptions([...base, "--authorize-pilot"], {});
  assert.deepEqual(parsed, { pilot: "pilot-test", profile: "paid-core-v1", locale: "es", cases: ["baseline"], capMicros: 10_000_000, output: undefined });
});

test("sampling CLI: refuses an enabled control and a provisional processor profile", () => {
  const base = ["--pilot", "pilot-test", "--profile", "paid-core-v1", "--cases", "baseline", "--max-spend-mxn", "10", "--authorize-pilot"];

  assert.equal(
    errorCode(() => parseSamplingOptions(base, { READINGS_GENERATION_ENABLED: "true" })),
    "sampling_control_enabled",
  );
  assert.equal(
    errorCode(() => parseSamplingOptions(base, { READINGS_PAID_GENERATION_ENABLED: "true" })),
    "sampling_control_enabled",
  );
  assert.equal(
    errorCode(() => parseSamplingOptions(base, {
      READINGS_PROCESSOR_PROFILE: JSON.stringify({ name: "OpenCode Console", policyVersion: "TBD-105" }),
    })),
    "sampling_profile_unqualified",
  );
  assert.equal(
    errorCode(() => parseSamplingOptions(base, {
      READINGS_PROCESSOR_PROFILE: JSON.stringify({ name: "OpenCode Console", policyVersion: "provisional" }),
    })),
    "sampling_profile_unqualified",
  );
  assert.equal(
    errorCode(() => parseSamplingOptions(base, {
      READINGS_GENERATION_ENABLED: "false",
      READINGS_PROCESSOR_PROFILE: JSON.stringify({ name: "OpenCode Console", policyVersion: "2026-11-22" }),
    })),
    "no-error",
  );
});

test("sampling: a cap below the first quote sends nothing and records no permit", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    await assert.rejects(
      runGenuineSampling({ config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider }, options(dir, { capMicros: 1 })),
      error => error instanceof SamplingError && error.code === "sampling_budget_exhausted",
    );
    assert.equal(calls.length, 0, "no transport call under the cap");
    const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.filter(line => line.type === "permit").length, 0, "no permit was committed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: a permit without a receipt halts and is never replayed", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const deps = { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider };
    await runGenuineSampling(deps, options(dir));
    const sent = calls.length;
    assert.equal(SECTION_MODEL_TIER.guidance, "strong", "the seeded permit uses the strong tier");
    // Crash between the fsynced permit append and the receipt append.
    appendFileSync(join(dir, "ledger.jsonl"), JSON.stringify({
      type: "permit",
      id: randomUUID(),
      caseId: "baseline",
      locale: "es",
      section: "guidance",
      phase: "primary",
      model: "test-strong",
      reservedMicros: quotes["test-strong"],
    }) + "\n");
    await assert.rejects(runGenuineSampling(deps, options(dir)), error => error instanceof SamplingError && error.code === "sampling_exposure_unresolved");
    assert.equal(calls.length, sent, "no replay of the unresolved slot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: an unknown receipt halts and is never replayed", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(() => { throw new Error("transport down"); });
    const deps = { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider };
    await assert.rejects(runGenuineSampling(deps, options(dir)), error => error instanceof SamplingError && error.code === "sampling_sample_incomplete");
    assert.equal(calls.length, 1);
    await assert.rejects(runGenuineSampling(deps, options(dir)), error => error instanceof SamplingError && error.code === "sampling_unknown_exposure");
    assert.equal(calls.length, 1, "resume must not send again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: resume skips settled samples and sends nothing twice", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const deps = { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider };
    const run = options(dir, { cases: ["baseline", "fold-earlier"] });
    const first = await runGenuineSampling(deps, run);
    assert.equal(first.report.samples.length, 2);
    const sent = calls.length;
    assert.equal(sent, PAID_CORE_SECTIONS.length * 2);
    const second = await runGenuineSampling(deps, run);
    assert.equal(second.report.samples.length, 2);
    assert.equal(calls.length, sent, "completed samples are not regenerated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: a run mismatch in the same directory refuses before sending", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const deps = { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider };
    await runGenuineSampling(deps, options(dir, { pilot: "pilot-one" }));
    const sent = calls.length;
    await assert.rejects(runGenuineSampling(deps, options(dir, { pilot: "pilot-two" })), error => error instanceof SamplingError && error.code === "sampling_run_mismatch");
    assert.equal(calls.length, sent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: one locale per run and provider identity", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const result = await runGenuineSampling({ config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider }, options(dir));
    assert.ok(calls.length > 0);
    assert.ok(calls.every(call => call.locale === "es"), "no other locale is requested");
    assert.equal(result.report.source, "provider");
    assert.equal(result.report.processor, "Test Processor");
    assert.equal(result.report.configHash, "b".repeat(64));
    assert.equal(result.report.contentVersion, "cv-test");
    assert.equal(result.report.profile, PAID_PROFILE);
    assert.equal(result.report.samples[0].factsHash, canonicalHash(coreCorpus.facts.baseline));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: the outbound prompt, digest, ledger and report carry no chart input", async () => {
  const dir = tempDir();
  try {
    const sentinel = {
      name: "PII-NAME-SENTINEL-103",
      birthDate: "1999-12-31",
      birthTime: "23:59",
      birthPlace: { name: "PII-PLACE-SENTINEL-103", latitude: 12.345, longitude: -67.89, timezone: "America/Tijuana" },
    };
    const corpus: SamplingCorpus = {
      ...coreCorpus,
      cases: coreCorpus.cases.map(entry => ({ ...entry, input: { ...entry.input, ...sentinel } })),
    };
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const result = await runGenuineSampling({ config: configFor(PAID_PROFILE, provider), corpus, provider }, options(dir));
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.prompt.includes("PII-"), false, "prompt has no name/place sentinel");
      assert.equal(call.prompt.includes("1999-12-31"), false, "prompt has no birth date");
      assert.equal(JSON.stringify(call.digest).includes("PII-"), false, "digest has no name/place sentinel");
      assert.equal(JSON.stringify(call.digest).includes("1999-12-31"), false, "digest has no birth date");
    }
    for (const bytes of [readFileSync(result.reportPath, "utf8"), readFileSync(join(dir, "ledger.jsonl"), "utf8")]) {
      assert.equal(bytes.includes("PII-"), false, "evidence has no name/place sentinel");
      assert.equal(bytes.includes("1999-12-31"), false, "evidence has no birth date");
    }
    assert.deepEqual(result.report.facts.baseline, coreCorpus.facts.baseline);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: all six cases run in both locales under fake transport", async () => {
  for (const locale of ["es", "en"] as const) {
    const dir = tempDir();
    try {
      const { provider, calls } = providerFor(request => fixture.complete(request));
      const cases = coreCorpus.cases.map(entry => entry.id);
      const result = await runGenuineSampling(
        { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider },
        options(dir, { pilot: `pilot-${locale}`, locale, cases }),
      );
      assert.equal(result.report.samples.length, cases.length);
      assert.ok(result.report.samples.every(sample => sample.locale === locale));
      assert.ok(calls.every(call => call.locale === locale));
      for (const sample of result.report.samples) {
        assert.equal(sample.sections.length, PAID_CORE_SECTIONS.length);
        assert.ok(sample.sections.every(section => section.status === "generated"));
        assert.deepEqual(evaluationSampleChecks(sample, PAID_PROFILE, coreCorpus.facts[sample.caseId], result.report.models), []);
      }
      assert.equal(result.report.samples[0].sections[0].title, PAID_SECTION_TITLES.overview[locale]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("sampling: a complete ledger reconstructs a missing report without calls", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const deps = { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider };
    await runGenuineSampling(deps, options(dir));
    const sent = calls.length;
    rmSync(join(dir, "report.json"));
    const again = await runGenuineSampling(deps, options(dir));
    assert.equal(calls.length, sent, "reconstruction must not dispatch");
    assert.equal(again.report.samples[0].sections.length, PAID_CORE_SECTIONS.length);
    assert.ok(again.report.samples[0].sections.every(section => section.status === "generated"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: a mid-sample crash resumes only the missing sections", async () => {
  const dir = tempDir();
  try {
    const { provider: firstProvider, calls: firstCalls } = providerFor(request => fixture.complete(request));
    await runGenuineSampling({ config: configFor(PAID_PROFILE, firstProvider), corpus: coreCorpus, provider: firstProvider }, options(dir));
    assert.equal(firstCalls.length, PAID_CORE_SECTIONS.length);
    const keep = new Set<string>(PAID_CORE_SECTIONS.slice(0, 4));
    const records = ledgerRecords(dir);
    const keptIds = new Set(records.filter(record => record.type === "permit" && keep.has(String(record.section))).map(record => String(record.id)));
    writeLedger(dir, records.filter(record => record.type === "run" || keptIds.has(String(record.id))));
    rmSync(join(dir, "report.json"));
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const resumed = await runGenuineSampling({ config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider }, options(dir));
    assert.equal(calls.length, PAID_CORE_SECTIONS.length - 4, "only the missing slots are dispatched");
    assert.ok(resumed.report.samples[0].sections.every(section => section.status === "generated"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: a terminal receipt makes a missing report archival, not retryable", async () => {
  const invalidDir = tempDir();
  try {
    const { provider } = providerFor(request => ({ output: { blocks: [] }, model: request.model, usage: { inputTokens: 10, outputTokens: 20 }, latencyMs: 5 }));
    const deps = { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider };
    await assert.rejects(runGenuineSampling(deps, options(invalidDir)), error => error instanceof SamplingError && error.code === "sampling_sample_incomplete");
    rmSync(join(invalidDir, "report.json"));
    const { provider: healthy, calls } = providerFor(request => fixture.complete(request));
    await assert.rejects(
      runGenuineSampling({ config: configFor(PAID_PROFILE, healthy), corpus: coreCorpus, provider: healthy }, options(invalidDir)),
      error => error instanceof SamplingError && error.code === "sampling_sample_incomplete",
    );
    assert.equal(calls.length, 0, "an invalid receipt is never re-derived");
    assert.equal(existsSync(join(invalidDir, "report.json")), false, "a sealed sample is not rewritten");
  } finally {
    rmSync(invalidDir, { recursive: true, force: true });
  }

  const notDispatchedDir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const deps = { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider };
    await runGenuineSampling(deps, options(notDispatchedDir));
    const records = ledgerRecords(notDispatchedDir);
    const index = records.findIndex(record => record.type === "receipt");
    records[index] = { ...records[index], basis: "not_dispatched", costMicros: 0, model: null, usage: null, outcome: null };
    writeLedger(notDispatchedDir, records);
    rmSync(join(notDispatchedDir, "report.json"));
    const sent = calls.length;
    await assert.rejects(runGenuineSampling(deps, options(notDispatchedDir)), error => error instanceof SamplingError && error.code === "sampling_sample_incomplete");
    assert.equal(calls.length, sent, "not_dispatched is terminal for a sealed sample");
    assert.equal(existsSync(join(notDispatchedDir, "report.json")), false, "a sealed sample is not rewritten");
  } finally {
    rmSync(notDispatchedDir, { recursive: true, force: true });
  }
});

test("sampling: a lock owned by a live process is not evicted", async () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, "lock"));
    writeFileSync(join(dir, "lock", "pid"), "1");
    const { provider, calls } = providerFor(request => fixture.complete(request));
    await assert.rejects(
      runGenuineSampling({ config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider }, options(dir)),
      error => error instanceof SamplingError && error.code === "sampling_locked",
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sampling: unknown case, corrupt ledger/report and identity mismatch refuse before sending", async () => {
  const clean = async (dir: string) => {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const deps = { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider };
    await runGenuineSampling(deps, options(dir));
    return { deps, sent: calls.length };
  };

  {
    const dir = tempDir();
    try {
      const { provider, calls } = providerFor(request => fixture.complete(request));
      await assert.rejects(
        runGenuineSampling({ config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider }, options(dir, { cases: ["does-not-exist"] })),
        error => error instanceof SamplingError && error.code === "sampling_case_unknown",
      );
      assert.equal(calls.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const dir = tempDir();
    try {
      const { deps, sent } = await clean(dir);
      appendFileSync(join(dir, "ledger.jsonl"), "not-json\n");
      await assert.rejects(runGenuineSampling(deps, options(dir)), error => error instanceof SamplingError && error.code === "sampling_ledger_invalid");
      assert.equal(sent, PAID_CORE_SECTIONS.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const dir = tempDir();
    try {
      const { deps } = await clean(dir);
      writeFileSync(join(dir, "report.json"), "{\n");
      await assert.rejects(runGenuineSampling(deps, options(dir)), error => error instanceof SamplingError && error.code === "sampling_output_invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    const dir = tempDir();
    try {
      const { deps } = await clean(dir);
      const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { configHash: string };
      report.configHash = "c".repeat(64);
      writeFileSync(join(dir, "report.json"), JSON.stringify(report));
      await assert.rejects(runGenuineSampling(deps, options(dir)), error => error instanceof SamplingError && error.code === "sampling_output_exists");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("sampling: one invalid primary is repaired; a second invalid repair stops the sample", async () => {
  const dir = tempDir();
  try {
    let call = 0;
    const { provider } = providerFor(request => {
      call += 1;
      return call % 2 === 1
        ? { output: { blocks: [] }, model: request.model, usage: { inputTokens: 10, outputTokens: 20 }, latencyMs: 5 }
        : fixture.complete(request);
    });
    const repaired = await runGenuineSampling({ config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider }, options(dir));
    assert.ok(repaired.report.samples[0].sections.every(section => section.status === "generated"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failedDir = tempDir();
  try {
    const { provider } = providerFor(request => ({ output: { blocks: [] }, model: request.model, usage: { inputTokens: 10, outputTokens: 20 }, latencyMs: 5 }));
    const deps = { config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider };
    await assert.rejects(runGenuineSampling(deps, options(failedDir)), error => error instanceof SamplingError && error.code === "sampling_sample_incomplete");
    const report = JSON.parse(readFileSync(join(failedDir, "report.json"), "utf8"));
    assert.ok(report.samples[0].sections.some((section: { status: string }) => section.status === "failed"));
    const issues = evaluationSampleChecks(report.samples[0], PAID_PROFILE, coreCorpus.facts.baseline, report.models);
    assert.ok(issues.includes("incomplete_report"), "a failed sample is never approvable");
  } finally {
    rmSync(failedDir, { recursive: true, force: true });
  }
});

test("sampling: the rich profile is a separate eleven-section manifest", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const result = await runGenuineSampling({ config: configFor(PAID_RICH_PROFILE, provider), corpus: richCorpus, provider }, options(dir, { profile: PAID_RICH_PROFILE }));
    assert.equal(result.report.profile, PAID_RICH_PROFILE);
    assert.equal(result.report.samples[0].sections.length, PAID_RICH_SECTIONS.length);
    assert.equal(calls.length, PAID_RICH_SECTIONS.length);
    assert.deepEqual(result.report.samples[0].sections.map(section => section.key), [...PAID_RICH_SECTIONS]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
