import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_OUTPUT_TOKENS_PER_SECTION } from "../src/readings/config";
import { costMicros } from "../src/readings/execution";
import { evaluationSampleChecks } from "../src/readings/evaluation";
import { PAID_CORE_SECTIONS, PAID_PROFILE, PAID_RICH_PROFILE, PAID_RICH_SECTIONS, type PaidProfile } from "../src/readings/paid-contract";
import type { PaidGenerationConfig } from "../src/readings/paid-policy";
import { canonicalHash } from "../src/readings/policy";
import { createFixtureProvider, type Completion, type CompletionRequest, type ReadingProvider } from "../src/readings/provider";
import { runGenuineSampling, SamplingError, type SamplingOptions } from "../src/readings/sampling";
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

test("sampling CLI: refuses without explicit authorization, cap, case list or profile agreement", () => {
  const base = ["--pilot", "pilot-test", "--profile", "paid-core-v1", "--cases", "baseline", "--max-spend-mxn", "10"];

  assert.equal(errorCode(() => parseSamplingOptions(base, {})), "sampling_authorization_missing");
  assert.equal(errorCode(() => parseSamplingOptions([...base, "--authorize-pilot"], { VERCEL: "1" })), "sampling_authorization_missing");
  assert.equal(errorCode(() => parseSamplingOptions([...base, "--authorize-pilot", "--bogus"], {})), "sampling_authorization_missing");
  assert.equal(errorCode(() => parseSamplingOptions(["--pilot", "pilot-test", "--authorize-pilot"], {})), "sampling_authorization_missing");
  assert.equal(errorCode(() => parseSamplingOptions(["--pilot", "pilot-test", "--cases", "baseline", "--max-spend-mxn", "21", "--authorize-pilot"], {})), "sampling_cap_invalid");
  assert.equal(errorCode(() => parseSamplingOptions([...base, "--authorize-pilot"], { READINGS_PAID_PROFILE: "paid-rich-v1" })), "sampling_profile_mismatch");

  const parsed = parseSamplingOptions([...base, "--authorize-pilot"], {});
  assert.deepEqual(parsed, { pilot: "pilot-test", profile: "paid-core-v1", locale: "es", cases: ["baseline"], capMicros: 10_000_000, output: undefined });
});

test("sampling: a cap below the first quote sends nothing and records no permit", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    await assert.rejects(
      runGenuineSampling({ config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider }, options(dir, { capMicros: 1 })),
      error => error instanceof SamplingError && error.code === "sampling_sample_incomplete",
    );
    assert.equal(calls.length, 0, "no transport call under the cap");
    const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.filter(line => line.type === "permit").length, 0, "no permit was committed");
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

test("sampling: one locale per run, provider identity and no PII in the evidence", async () => {
  const dir = tempDir();
  try {
    const { provider, calls } = providerFor(request => fixture.complete(request));
    const result = await runGenuineSampling({ config: configFor(PAID_PROFILE, provider), corpus: coreCorpus, provider }, options(dir));
    assert.ok(calls.length > 0);
    assert.ok(calls.every(call => call.locale === "es"), "no other locale is requested");
    const bytes = readFileSync(result.reportPath, "utf8");
    const input = coreCorpus.cases.find(entry => entry.id === "baseline")!.input;
    assert.equal(bytes.includes(input.name), false, "no name");
    assert.equal(bytes.includes(input.birthDate), false, "no birth date");
    assert.equal(bytes.includes(input.birthPlace.name), false, "no birth place");
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
