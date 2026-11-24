import "dotenv/config";
import { db, pool, coordinationPool } from "../src/db";
import { paidReadingApprovals } from "../src/db/schema";
import { paidGenerationConfig } from "../src/readings/paid-policy";
import { paidEvaluationSchema, validateEditorialApproval } from "../src/readings/evaluation";
import { boundedJson, loadPaidEvaluationCorpus } from "./lib/paid-evaluation-corpus";

/** Privileged operator tool. Validation is default; --record is an explicit DB
 * mutation, not deployment/activation permission. Never enables a control flag.
 */
async function main() {
  const args = process.argv.slice(2); const values: Record<string, string> = {}; let record = false;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--record" && !record) record = true;
    else if (["--report", "--review"].includes(arg) && !values[arg] && args[0] && !args[0].startsWith("--")) values[arg] = args.shift()!;
    else throw Error("invalid_arguments");
  }
  if (!values["--report"] || !values["--review"]) throw Error("invalid_arguments");
  const report = paidEvaluationSchema.parse(boundedJson(values["--report"]));
  if (report.source !== "provider") throw Error("synthetic_is_not_editorial_approval");
  const config = paidGenerationConfig(); if (!config) throw Error("paid_configuration_unavailable");
  const corpus = loadPaidEvaluationCorpus(config.editionProfile);
  const approval = validateEditorialApproval(report, boundedJson(values["--review"]), {
    profile: config.editionProfile, configHash: config.fingerprint, contentVersion: config.contentVersion, processor: config.profile.name,
    models: config.settings.models, settings: config.settings, inputTokenLimits: config.profile.inputTokenLimits, servedModels: config.profile.servedModels,
    corpusHash: corpus.corpusHash, facts: corpus.facts, schemaHash: corpus.schemaHash, promptHashes: corpus.promptHashes,
  });
  if (!record) { console.log("Editorial evidence validates against the current profile/configuration. Check-only: no approval recorded; generation remains unchanged."); return; }
  const inserted = await db.insert(paidReadingApprovals).values(approval).onConflictDoNothing().returning({ locale: paidReadingApprovals.locale });
  if (!inserted.length) throw Error("approval_already_exists_no_overwrite");
  console.log(`Recorded ${approval.sampleCount} reviewed full reports for ${approval.profile}/${approval.locale}. Generation controls remain unchanged.`);
}
void main().catch(() => { console.error("Editorial approval refused. Check explicit report/review paths, genuine provider evidence, six reviewed reports in the selected locale, and exact current profile/configuration. Existing approvals are never overwritten. No control was enabled."); process.exitCode = 1; })
  .finally(async () => { await Promise.all([pool.end(), coordinationPool.end()]); });
