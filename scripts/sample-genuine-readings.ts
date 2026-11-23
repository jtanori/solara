import { config as loadEnv } from "dotenv";
// The local pilot treats .env as authoritative: a stale exported READINGS_*
// (for example, an old key or base URL from a previous `set -a`) must not
// silently run a different provider. The worker keeps plain dotenv semantics.
loadEnv({ override: true });
import { resolve } from "node:path";
import { evaluationHash } from "../src/readings/evaluation";
import { PAID_PROFILES } from "../src/readings/paid-contract";
import { paidGenerationConfig } from "../src/readings/paid-policy";
import { runGenuineSampling, SamplingError } from "../src/readings/sampling";
import { PILOT_HARD_CAP_MICROS, parseSamplingOptions } from "../src/readings/sampling-options";
import { loadPaidEvaluationCorpus } from "./lib/paid-evaluation-corpus";

/*
 * Bounded genuine sampling CLI (S2-a, #103).
 *
 * This is the only entry point. It is not a route, worker, build step or deploy
 * hook. It refuses unless the operator supplies a pilot id, an explicit
 * authorization flag, an explicit case list and a spend cap, plus a complete
 * provider/processor/model/price configuration.
 *
 * It never enables the app generation switches, never touches the database and
 * never writes an editorial approval.
 */

const usage = `Usage:
  npm run readings:sample -- \\
    --pilot <id> --profile paid-core-v1|paid-rich-v1 --locale es|en \\
    --cases <case,...> --max-spend-mxn <n> --authorize-pilot [--output <dir>]

Requires the usual READINGS_PROVIDER=chat-completions, READINGS_PROCESSOR_PROFILE,
READINGS_API_BASE_URL, READINGS_API_KEY, READINGS_CHEAP_MODEL, READINGS_STRONG_MODEL,
READINGS_MODEL_PRICES and READINGS_PAID_PROFILE configuration. Case ids come from
tests/fixtures/readings/paid-corpus-v1.json. The per-invocation cap is ${PILOT_HARD_CAP_MICROS / 1_000_000} MXN;
the pilot total (core + rich) is two explicit invocations, and a third invocation or a new
pilot id is a new authorization.`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(usage);
    return;
  }
  const options = parseSamplingOptions(argv, process.env);
  // paidGenerationConfig reads the exact profile from the environment. Set it
  // only in this process; no generation switch is enabled.
  process.env.READINGS_PAID_PROFILE = options.profile;

  const config = paidGenerationConfig();
  if (!config) throw new SamplingError("sampling_configuration_unavailable");
  if (config.editionProfile !== options.profile) throw new SamplingError("sampling_profile_mismatch");

  const corpus = loadPaidEvaluationCorpus(config.editionProfile);
  for (const id of options.cases) {
    if (!corpus.cases.some(entry => entry.id === id)) throw new SamplingError("sampling_case_unknown");
  }

  const outputDir = resolve(options.output ?? `.venv/genuine-sampling/${options.pilot}`);
  const result = await runGenuineSampling(
    { config, corpus, provider: config.provider },
    { outputDir, pilot: options.pilot, profile: options.profile, locale: options.locale, cases: options.cases, capMicros: options.capMicros },
  );

  console.log(JSON.stringify({
    pilot: options.pilot,
    profile: config.editionProfile,
    locale: options.locale,
    cases: options.cases,
    samples: result.report.samples.length,
    capMxn: options.capMicros / 1_000_000,
    exposureMxn: result.exposureMicros / 1_000_000,
    reportHash: evaluationHash(result.report),
    report: result.reportPath,
    ledger: result.ledgerPath,
    approval: "NOT APPROVED",
  }, null, 2));
}

void main().catch(error => {
  const code = error instanceof SamplingError ? error.code : "sampling_unavailable";
  console.error(`sampling failed: ${code}`);
  if (code === "sampling_authorization_missing") console.error(usage);
  if (code === "sampling_sample_incomplete") {
    console.error("This pilot directory is archival evidence. Start a new --pilot id to retry; do not delete individual ledger lines.");
  }
  if (code === "sampling_budget_exhausted") {
    console.error("The per-invocation cap was reached. Start a new explicitly authorized invocation.");
  }
  console.error(`profiles: ${PAID_PROFILES.join("|")}`);
  process.exitCode = 1;
});
