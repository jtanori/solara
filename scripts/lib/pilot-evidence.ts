import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  PAID_EDITORIAL_MINIMUM,
  approvalIssues,
  evaluationHash,
  evaluationMetrics,
  evaluationSampleChecks,
  paidEvaluationSchema,
  type PaidEvaluationReport,
} from "../../src/readings/evaluation";
import type { PaidGenerationConfig } from "../../src/readings/paid-policy";
import { canonicalHash } from "../../src/readings/policy";
import { computeContentVersion } from "../../src/readings/content-version";
import { blockText } from "../../src/readings/presentation";
import { loadPaidEvaluationCorpus } from "./paid-evaluation-corpus";

/**
 * #225 — read-only evidence inventory for the pilot reports on disk.
 *
 * Nothing here calls a provider or a database. It validates each report, recomputes its hash and
 * metrics, derives the mechanical blockers, and decides whether the report could be approved now.
 * The verdict delegates to the same `approvalIssues` the editorial gate uses, per locale, so the
 * two cannot disagree. Without the pilot environment the tool can only judge the parts that do not
 * need it; the rest is reported as `unknown`, never as `pass`.
 */

export type PilotBlockers = Record<string, string[]>;

export type PilotEvidence = {
  pilot: string;
  profile: PaidEvaluationReport["profile"];
  locale: string;
  samples: number;
  cases: number;
  sectionsGenerated: number;
  sectionsTotal: number;
  measuredMicros: number;
  uncertainMicros: number;
  repairs: number;
  failedAttempts: number;
  p95LatencyMs: number | null;
  reportHash: string;
  contentVersion: string;
  configHash: string;
  processor: string;
  models: PaidEvaluationReport["models"];
  /** Same predicate as the editorial gate, per locale. `unknown` means the pilot env was absent. */
  gate: Record<"en" | "es", GateVerdict>;
  gateIssues: Record<"en" | "es", string[]>;
  reasons: string[];
  blockers: PilotBlockers;
};

export type GateVerdict = "pass" | "fail" | "unknown";

export type ContentVersionSource = "explicit" | "env" | "absent";
export type ContentVersionResolution = { version: string | null; source: ContentVersionSource; envFingerprint: string };

/** The environment inputs contentVersion hashes, without any secret. */
export function envFingerprint(env: Record<string, string | undefined> = process.env): string {
  return canonicalHash({
    provider: env.READINGS_PROVIDER ?? null,
    processorProfile: env.READINGS_PROCESSOR_PROFILE ?? null,
    baseUrl: env.READINGS_API_BASE_URL ?? null,
    cheap: env.READINGS_CHEAP_MODEL ?? null,
    strong: env.READINGS_STRONG_MODEL ?? null,
  });
}

/** A generation environment, not the app default: without these, contentVersion is not comparable. */
export function pilotEnvComplete(env: Record<string, string | undefined> = process.env): boolean {
  return ["READINGS_PROVIDER", "READINGS_PROCESSOR_PROFILE", "READINGS_CHEAP_MODEL", "READINGS_STRONG_MODEL"]
    .every(key => (env[key] ?? "").trim() !== "");
}

/**
 * contentVersion hashes prompts, schemas *and* the resolved environment. Computing it in a shell
 * that never had the pilot env produces a different digest for identical code, so a plain
 * comparison would call a report stale when only the environment differs. Trust an explicit value;
 * compute from the environment only when that environment is demonstrably a generation one;
 * otherwise report `unknown` and let the caller refuse to claim anything.
 */
export function resolveContentVersion(
  explicit: string | null,
  env: Record<string, string | undefined> = process.env,
  compute: () => string = computeContentVersion,
): ContentVersionResolution {
  const fingerprint = envFingerprint(env);
  if (explicit) return { version: explicit, source: "explicit", envFingerprint: fingerprint };
  if (!pilotEnvComplete(env)) return { version: null, source: "absent", envFingerprint: fingerprint };
  try {
    return { version: compute(), source: "env", envFingerprint: fingerprint };
  } catch {
    return { version: null, source: "absent", envFingerprint: fingerprint };
  }
}

export type PilotScan = {
  currentContentVersion: string | null;
  pilots: PilotEvidence[];
  errors: { pilot: string; reason: string }[];
};

export type PilotStructure = {
  version: "pilot-structures/1";
  generatedFrom: { pilot: string; reportHash: string; contentVersion: string }[];
  cases: {
    pilot: string;
    profile: PaidEvaluationReport["profile"];
    locale: string;
    caseId: string;
    sections: {
      key: string;
      status: string;
      blocks: { kind: string; chars: number }[];
      closingQuestionChars: number;
    }[];
  }[];
};

/** Report-wide (all attempts, all locales). The report's own `attemptLatencyP95Ms` is per locale. */
function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function reasonsFor(report: PaidEvaluationReport, blockers: PilotBlockers, currentContentVersion: string | null): string[] {
  const reasons = new Set<string>();
  if (report.source !== "provider") reasons.add("synthetic_source");
  if (/fixture|synthetic/i.test(report.processor) || Object.values(report.models).some(model => /fixture|synthetic/i.test(model))) {
    reasons.add("synthetic_source");
  }
  const cases = new Set(report.samples.map(sample => sample.caseId));
  if (report.samples.length < PAID_EDITORIAL_MINIMUM || cases.size < PAID_EDITORIAL_MINIMUM) reasons.add("fewer_than_six_cases");
  // A difference is reported as a difference: the version also hashes the resolved environment,
  // so a mismatch alone does not prove that the code changed.
  if (currentContentVersion === null) reasons.add("content_version_unknown");
  else if (report.contentVersion !== currentContentVersion) reasons.add("content_version_differs");
  for (const [caseId, issues] of Object.entries(blockers)) {
    if (issues.length > 0) reasons.add(`blockers:${caseId}`);
  }
  return [...reasons].sort();
}

/**
 * The editorial gate, per locale, with the context this tool can actually see. Optional fields are
 * filled from the pilot environment when present; a missing environment can only produce `unknown`.
 */
function gateContext(report: PaidEvaluationReport, config: PaidGenerationConfig | null) {
  const corpus = loadPaidEvaluationCorpus(report.profile);
  return {
    profile: config?.editionProfile ?? report.profile,
    facts: corpus.facts,
    corpusHash: corpus.corpusHash,
    schemaHash: corpus.schemaHash,
    promptHashes: corpus.promptHashes,
    ...(config === null ? {} : {
      contentVersion: config.contentVersion,
      configHash: config.fingerprint,
      models: config.settings.models,
      processor: config.profile.name,
      settings: config.settings,
      inputTokenLimits: config.profile.inputTokenLimits,
      servedModels: config.profile.servedModels,
    }),
  };
}

export function gateIssuesByLocale(report: PaidEvaluationReport, config: PaidGenerationConfig | null): Record<"en" | "es", string[]> {
  const context = gateContext(report, config);
  return Object.fromEntries((["en", "es"] as const).map(locale => [locale, approvalIssues(report, { ...context, locale })])) as Record<"en" | "es", string[]>;
}

/** Same predicate as the editorial gate, per locale; `unknown` when the environment is missing. */
export function gateVerdicts(report: PaidEvaluationReport, config: PaidGenerationConfig | null): Record<"en" | "es", GateVerdict> {
  const issues = gateIssuesByLocale(report, config);
  return Object.fromEntries((["en", "es"] as const).map(locale => [
    locale,
    issues[locale].length > 0 ? "fail" : config === null ? "unknown" : "pass",
  ])) as Record<"en" | "es", GateVerdict>;
}

export function inspectReport(report: PaidEvaluationReport, pilot: string, currentContentVersion: string | null, config: PaidGenerationConfig | null = null): PilotEvidence {
  const blockers: PilotBlockers = {};
  for (const sample of report.samples) {
    const facts = report.facts[sample.caseId];
    blockers[sample.caseId] = facts
      ? evaluationSampleChecks(sample, report.profile, facts, report.models)
      : ["facts_missing"];
  }

  const metrics = evaluationMetrics(report);
  const locales = Object.values(metrics);
  const attempts = report.samples.flatMap(sample => sample.attempts);
  const reasons = reasonsFor(report, blockers, currentContentVersion);

  return {
    pilot,
    profile: report.profile,
    locale: report.samples[0]?.locale ?? "unknown",
    samples: report.samples.length,
    cases: new Set(report.samples.map(sample => sample.caseId)).size,
    sectionsGenerated: report.samples.flatMap(sample => sample.sections).filter(section => section.status === "generated").length,
    sectionsTotal: report.samples.flatMap(sample => sample.sections).length,
    measuredMicros: locales.reduce((sum, row) => sum + row.measuredMicros, 0),
    uncertainMicros: locales.reduce((sum, row) => sum + row.uncertainMicros, 0),
    repairs: locales.reduce((sum, row) => sum + row.repairs, 0),
    failedAttempts: locales.reduce((sum, row) => sum + row.failedAttempts, 0),
    p95LatencyMs: p95(attempts.map(attempt => attempt.latencyMs)),
    reportHash: evaluationHash(report),
    contentVersion: report.contentVersion,
    configHash: report.configHash,
    processor: report.processor,
    models: report.models,
    gate: gateVerdicts(report, config),
    gateIssues: gateIssuesByLocale(report, config),
    reasons,
    blockers,
  };
}

export function inspectPilotFile(reportPath: string, pilot: string, currentContentVersion: string | null, config: PaidGenerationConfig | null = null): PilotEvidence {
  const value = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
  const report = paidEvaluationSchema.parse(value);
  return inspectReport(report, pilot, currentContentVersion, config);
}

export function scanPilots(root: string, currentContentVersion: string | null, config: PaidGenerationConfig | null = null): PilotScan {
  const pilots: PilotEvidence[] = [];
  const errors: { pilot: string; reason: string }[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch {
    return { currentContentVersion, pilots, errors: [{ pilot: root, reason: "root_unreadable" }] };
  }
  for (const pilot of entries) {
    const file = path.join(root, pilot, "report.json");
    try {
      pilots.push(inspectPilotFile(file, pilot, currentContentVersion, config));
    } catch (error) {
      const reason = error instanceof SyntaxError ? "invalid_json" : error instanceof Error ? error.message.split("\n")[0] : "invalid_report";
      errors.push({ pilot, reason });
    }
  }
  return { currentContentVersion, pilots, errors };
}

/** Structural fixture: block kinds and character counts, never prose. */
export function buildStructures(reports: { pilot: string; report: PaidEvaluationReport }[]): PilotStructure {
  // A 0/9 or 0/11 report carries no layout value: its sections are empty. Keep only reports with at
  // least one generated section, so the fixture describes what the page/PDF actually render.
  const usable = reports
    .map(({ pilot, report }) => ({
      pilot,
      report,
      samples: report.samples.filter(sample => sample.sections.some(section => section.status === "generated")),
    }))
    .filter(entry => entry.samples.length > 0);
  return {
    version: "pilot-structures/1",
    generatedFrom: usable.map(({ pilot, report }) => ({ pilot, reportHash: evaluationHash(report), contentVersion: report.contentVersion })),
    cases: usable.flatMap(({ pilot, report, samples }) =>
      samples.map(sample => ({
        pilot,
        profile: report.profile,
        locale: sample.locale,
        caseId: sample.caseId,
        sections: sample.sections.map(section => ({
          key: section.key,
          status: section.status,
          blocks: section.blocks.map(block => ({ kind: block.kind, chars: blockText(block).join(" ").length })),
          closingQuestionChars: section.closingQuestion?.length ?? 0,
        })),
      })),
    ),
  };
}

export function readReports(root: string): { pilot: string; report: PaidEvaluationReport }[] {
  const reports: { pilot: string; report: PaidEvaluationReport }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "report.json");
    try {
      reports.push({ pilot: entry.name, report: paidEvaluationSchema.parse(JSON.parse(readFileSync(file, "utf8")) as unknown) });
    } catch {
      // scanPilots reports corrupt inputs; the structure builder simply skips them.
    }
  }
  return reports.sort((a, b) => a.pilot.localeCompare(b.pilot));
}

export function writeStructures(file: string, structure: PilotStructure): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(structure, null, 2) + "\n");
}
