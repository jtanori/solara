import { CANONICAL_HASH_SCHEME, canonicalHash, hash } from "../../src/readings/policy";
import { paidGenerationConfig, paidOfferHash } from "../../src/readings/paid-policy";
import { calculatePaidSnapshot, paidSnapshotHash, readPaidSnapshot } from "../../src/readings/paid-chart";
import { PAID_PROFILES } from "../../src/readings/paid-contract";
import { evaluationHash, evaluationSampleHash } from "../../src/readings/evaluation";
import { readingChartInput } from "./reading-fixtures";
import { syntheticPaidEvaluation } from "./paid-evaluation";

export const identityReadingId = "11111111-1111-4111-8111-111111111111";
export function reverseObjects(value: unknown): unknown {
  return Array.isArray(value) ? value.map(reverseObjects) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjects(child)])) : value;
}
export function identityEnvironment(reverse = false): Record<string, string> {
  const encode = (value: unknown) => JSON.stringify(reverse ? reverseObjects(value) : value);
  return { READINGS_PROVIDER: "chat-completions", READINGS_CHEAP_MODEL: "Index", READINGS_STRONG_MODEL: "index", READINGS_PAID_PROFILE: "paid-core-v1",
    READINGS_API_BASE_URL: "https://processor.invalid/v1", READINGS_API_KEY: "SYNTHETIC_IDENTITY_KEY",
    READINGS_PROCESSOR_PROFILE: encode({ id: "identity-fixture", name: "Synthetic identity processor", policyVersion: "test-1",
      inputTokenLimits: { Index: 6000, index: 8000 }, servedModels: { Index: ["Index", "Index.A"], index: ["index", "index.a"] } }),
    READINGS_MODEL_PRICES: encode(Object.fromEntries(["Index", "Index.A", "index", "index.a"].map(model => [model, { inputMxnPerMillion: 15, outputMxnPerMillion: 60 }]))),
  };
}

/** Original algorithm, only in TESTS to prove legacy read compatibility. */
export function originalSnapshotHash(value: unknown): string {
  const ordered = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(ordered) : entry !== null && typeof entry === "object"
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)])) : entry;
  return hash(ordered(value));
}

/** Separate processes choose ICU locale at startup; setting process.env alone
 * inside a running test would not reproduce this defect. No transport is sent. */
export async function identityProbe() {
  const config = paidGenerationConfig(() => { throw new Error("identity checks must not send provider requests"); });
  if (!config) throw new Error("invalid synthetic config");
  const snapshots = PAID_PROFILES.map(profile => {
    const snapshot = calculatePaidSnapshot(identityReadingId, readingChartInput, profile);
    const legacy = readPaidSnapshot({ ...snapshot, version: profile === "paid-core-v1" ? "paid-snapshot/1" : "paid-snapshot/2" });
    return { profile, version: snapshot.version, hash: paidSnapshotHash(snapshot),
      reorderedHash: paidSnapshotHash(readPaidSnapshot(reverseObjects(snapshot))), legacyHash: paidSnapshotHash(legacy), originalHash: originalSnapshotHash(legacy) };
  });
  const report = await syntheticPaidEvaluation("paid-rich-v1");
  // The protocol fixture records real elapsed latency; freeze this TEST value so
  // the two processes hash the same report, not two intentionally different ones.
  for (const sample of report.samples) for (const attempt of sample.attempts) attempt.latencyMs = 1;
  return { scheme: CANONICAL_HASH_SCHEME, config: config.fingerprint, contentVersion: config.contentVersion,
    offer: paidOfferHash(config, 1, "2026-11", "en"), settings: canonicalHash(config.settings), snapshots,
    report: evaluationHash(report), sample: evaluationSampleHash(report.samples[0]), corpus: report.corpusHash,
    modelVector: canonicalHash({ Index: 1, index: 2, "İndex": 3, "ı": 4, nested: { Z: 1, a: 2 } }) };
}
