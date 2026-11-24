import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ChartDigest } from "@/lib/chart";
import type { Locale } from "@/lib/i18n";
import { MAX_OUTPUT_TOKENS_PER_SECTION, SECTION_MODEL_TIER } from "@/readings/config";
import { PAID_SECTION_TITLES } from "@/readings/copy";
import {
  PAID_CORPUS_VERSION,
  PAID_EVALUATION_VERSION,
  paidEvaluationSchema,
  type EvaluationAttempt,
  type EvaluationSample,
  type PaidEvaluationReport,
} from "@/readings/evaluation";
import { dispatchAttempt, GenerationBlocked, validateAttemptSettlement, type AttemptSettlement, type GenerationExecution, type GenerationSettings } from "@/readings/execution";
import { assembleSectionPrompt } from "@/readings/generate";
import { PAID_PROFILES, type PaidProfile } from "@/readings/paid-contract";
import type { PaidGenerationConfig } from "@/readings/paid-policy";
import { canonicalHash } from "@/readings/policy";
import type { ReadingProvider } from "@/readings/provider";
import { sectionJsonSchema, validateSectionOutput, type SectionOutput } from "@/readings/schemas";
import type { SectionKey } from "@/readings/types";

/*
 * Bounded genuine sampling (S2-a, #103).
 *
 * This module is not imported by an application route, worker, build step or
 * deploy. It runs only from scripts/sample-genuine-readings.ts after an explicit
 * operator authorization, and it never writes an approval.
 *
 * The ledger is a local append-only JSONL file, deliberately outside the paid
 * database tables. A permit without a receipt and an `unknown` receipt both halt
 * a later run: they are potentially billable and are never replayed.
 */

export type SamplingCode =
  | "sampling_authorization_missing"
  | "sampling_control_enabled"
  | "sampling_configuration_unavailable"
  | "sampling_profile_mismatch"
  | "sampling_profile_unqualified"
  | "sampling_case_unknown"
  | "sampling_cap_invalid"
  | "sampling_run_mismatch"
  | "sampling_ledger_invalid"
  | "sampling_output_invalid"
  | "sampling_output_exists"
  | "sampling_exposure_unresolved"
  | "sampling_unknown_exposure"
  | "sampling_budget_exhausted"
  | "sampling_sample_incomplete"
  | "sampling_locked";

export class SamplingError extends Error {
  constructor(readonly code: SamplingCode) {
    super(code);
    this.name = "SamplingError";
  }
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const caseId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const localeSchema = z.enum(["en", "es"]);
const micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const attemptId = z.string().uuid();

const runRecordSchema = z.strictObject({
  type: z.literal("run"),
  format: z.literal("solara-sampling/1"),
  pilot: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  profile: z.enum(PAID_PROFILES),
  locale: localeSchema,
  cases: z.array(caseId).min(1).max(48),
  capMicros: z.number().int().positive().max(20_000_000),
  contentVersion: z.string().min(1).max(128),
  configHash: hash,
  startedAt: z.string().datetime(),
});
type RunRecord = z.infer<typeof runRecordSchema>;

const permitRecordSchema = z.strictObject({
  type: z.literal("permit"),
  id: attemptId,
  caseId,
  locale: localeSchema,
  section: z.string().min(1).max(40),
  phase: z.enum(["primary", "repair"]),
  model: z.string().min(1).max(128),
  reservedMicros: micros,
});
type PermitRecord = z.infer<typeof permitRecordSchema>;

const outcomeSchema = z.union([
  z.strictObject({ kind: z.literal("valid"), output: z.unknown() }),
  z.strictObject({ kind: z.literal("invalid") }),
]);

const receiptRecordSchema = z.strictObject({
  type: z.literal("receipt"),
  id: attemptId,
  basis: z.enum(["measured", "unknown", "not_dispatched"]),
  costMicros: micros,
  model: z.string().min(1).max(128).nullable(),
  usage: z.strictObject({ inputTokens: micros, outputTokens: micros }).nullable(),
  latencyMs: micros,
  code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
  outcome: outcomeSchema.nullable(),
});
type ReceiptRecord = z.infer<typeof receiptRecordSchema>;

const lineSchema = z.discriminatedUnion("type", [runRecordSchema, permitRecordSchema, receiptRecordSchema]);

export type SamplingCorpus = {
  cases: ReadonlyArray<{ id: string }>;
  facts: Record<string, ChartDigest>;
  corpusHash: string;
  schemaHash: string;
  promptHashes: Record<string, string>;
};

export type SamplingOptions = {
  outputDir: string;
  pilot: string;
  profile: PaidProfile;
  locale: Locale;
  cases: string[];
  capMicros: number;
};

export type SamplingDeps = {
  config: PaidGenerationConfig;
  corpus: SamplingCorpus;
  provider: ReadingProvider;
};

export type SamplingResult = {
  report: PaidEvaluationReport;
  reportPath: string;
  exposureMicros: number;
  ledgerPath: string;
};

function appendJsonLine(path: string, value: unknown) {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SamplingError("sampling_output_invalid");
  }
}

function processAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another user. Only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireLock(outputDir: string): () => void {
  const lock = join(outputDir, "lock");
  try {
    // A crash between mkdir and the pid write leaves a stale, removable lock. A
    // concurrent reader can see the directory before the pid file exists and
    // remove it; the window is small and pilots are operator-serialized, so it
    // is acknowledged rather than widened into a portable lock protocol here.
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let pid = 0;
    try {
      pid = Number(readFileSync(join(lock, "pid"), "utf8"));
    } catch {
      // A crash between mkdir and the pid write leaves a stale, removable lock.
    }
    if (processAlive(pid)) throw new SamplingError("sampling_locked");
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  writeFileSync(join(lock, "pid"), String(process.pid));
  return () => rmSync(lock, { recursive: true, force: true });
}

function sameRun(existing: RunRecord, wanted: Omit<RunRecord, "type" | "format" | "startedAt">) {
  return existing.pilot === wanted.pilot && existing.profile === wanted.profile &&
    existing.locale === wanted.locale && existing.capMicros === wanted.capMicros &&
    existing.contentVersion === wanted.contentVersion && existing.configHash === wanted.configHash &&
    existing.cases.length === wanted.cases.length && existing.cases.every((id, index) => id === wanted.cases[index]);
}

/**
 * Append-only local ledger implementing the same permit/receipt contract as the
 * durable paid store. `kind: "durable"` makes `dispatchAttempt` require a
 * provider that can quote its full input bound (`prepare`).
 */
export class SamplingLedger implements GenerationExecution {
  readonly kind = "durable" as const;
  readonly settings: GenerationSettings;
  readonly ceilingMicros: number;
  readonly admitsModel: GenerationExecution["admitsModel"];
  readonly ledgerPath: string;

  private readonly permits = new Map<string, PermitRecord>();
  private readonly receipts = new Map<string, ReceiptRecord>();
  private readonly quotes: Record<string, number>;
  private readonly releaseLock: () => void;
  private sample: { caseId: string; locale: Locale } | null = null;
  private exposureMicros = 0;

  private constructor(
    readonly outputDir: string,
    readonly run: RunRecord,
    settings: GenerationSettings,
    ceilingMicros: number,
    quotes: Record<string, number>,
    servedModels: Record<string, string[]>,
    releaseLock: () => void,
  ) {
    this.settings = settings;
    this.ceilingMicros = ceilingMicros;
    this.quotes = quotes;
    this.admitsModel = (requested, reported) => Boolean(servedModels[requested]?.includes(reported));
    this.ledgerPath = join(outputDir, "ledger.jsonl");
    this.releaseLock = releaseLock;
  }

  static open(options: SamplingOptions, config: PaidGenerationConfig): SamplingLedger {
    mkdirSync(options.outputDir, { recursive: true });
    const releaseLock = acquireLock(options.outputDir);
    try {
      const runPath = join(options.outputDir, "run.json");
      const ledgerPath = join(options.outputDir, "ledger.jsonl");
      const wanted = {
        pilot: options.pilot,
        profile: options.profile,
        locale: options.locale,
        cases: options.cases,
        capMicros: options.capMicros,
        contentVersion: config.contentVersion,
        configHash: config.fingerprint,
      };
      let run: RunRecord;
      if (existsSync(runPath)) {
        const parsed = runRecordSchema.safeParse(readJson(runPath));
        if (!parsed.success || !sameRun(parsed.data, wanted)) throw new SamplingError("sampling_run_mismatch");
        run = parsed.data;
      } else {
        run = runRecordSchema.parse({ type: "run", format: "solara-sampling/1", ...wanted, startedAt: new Date().toISOString() });
        writeJsonAtomic(runPath, run);
      }

      const ledger = new SamplingLedger(options.outputDir, run, config.settings, options.capMicros, config.quotes, config.profile.servedModels, releaseLock);
      if (existsSync(ledgerPath)) {
        const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
        for (const [index, line] of lines.entries()) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            throw new SamplingError("sampling_ledger_invalid");
          }
          const parsed = lineSchema.safeParse(value);
          if (!parsed.success) throw new SamplingError("sampling_ledger_invalid");
          const record = parsed.data;
          if (record.type === "run") {
            if (index !== 0 || !sameRun(record, wanted)) throw new SamplingError("sampling_ledger_invalid");
            continue;
          }
          if (record.type === "permit") {
            if (ledger.permits.has(record.id)) throw new SamplingError("sampling_ledger_invalid");
            ledger.permits.set(record.id, record);
            continue;
          }
          if (!ledger.permits.has(record.id) || ledger.receipts.has(record.id)) throw new SamplingError("sampling_ledger_invalid");
          ledger.receipts.set(record.id, record);
        }
      } else {
        appendJsonLine(ledgerPath, run);
      }
      ledger.recomputeExposure();
      return ledger;
    } catch (error) {
      releaseLock();
      throw error;
    }
  }

  /** Refuse before any new call when a previous run left billable uncertainty. */
  assertResumable() {
    for (const [id] of this.permits) {
      const receipt = this.receipts.get(id);
      if (!receipt) throw new SamplingError("sampling_exposure_unresolved");
      if (receipt.basis === "unknown") throw new SamplingError("sampling_unknown_exposure");
    }
  }

  beginSample(caseId: string, locale: Locale) {
    this.sample = { caseId, locale };
  }

  endSample() {
    this.sample = null;
  }

  receiptFor(caseId: string, locale: Locale, section: SectionKey, phase: "primary" | "repair"): ReceiptRecord | undefined {
    for (const [id, permit] of this.permits) {
      if (permit.caseId !== caseId || permit.locale !== locale || permit.section !== section || permit.phase !== phase) continue;
      const receipt = this.receipts.get(id);
      if (receipt) return receipt;
    }
    return undefined;
  }

  validOutcome(caseId: string, locale: Locale, section: SectionKey): SectionOutput | null {
    for (const phase of ["primary", "repair"] as const) {
      const receipt = this.receiptFor(caseId, locale, section, phase);
      if (!receipt?.outcome || receipt.outcome.kind !== "valid") continue;
      const checked = validateSectionOutput(section, receipt.outcome.output, "paid");
      if (checked.ok) return checked.value;
    }
    return null;
  }

  /**
   * Predicted outcome of a sample from the ledger alone, before any dispatch.
   * `blocked` means no sequence of calls can complete it: a terminal receipt
   * (unknown, not_dispatched, unreadable checkpoint, or an exhausted repair)
   * closes the sample. A missing slot or a primary awaiting repair is resumable.
   * This mirrors the per-section branches in runSample.
   */
  sampleState(caseId: string, locale: Locale, sections: readonly SectionKey[]): "complete" | "resumable" | "blocked" {
    let complete = true;
    for (const section of sections) {
      if (this.validOutcome(caseId, locale, section)) continue;
      complete = false;
      const primary = this.receiptFor(caseId, locale, section, "primary");
      const repair = this.receiptFor(caseId, locale, section, "repair");
      if (!primary) {
        // A repair without its primary is corrupt; no permit at all is resumable.
        if (repair) return "blocked";
        continue;
      }
      if (!primary.outcome) return "blocked";
      if (primary.outcome.kind !== "invalid") return "blocked";
      // The repair slot can still run only when no repair receipt exists.
      if (repair) return "blocked";
    }
    return complete ? "complete" : "resumable";
  }

  attemptsFor(caseId: string, locale: Locale): EvaluationAttempt[] {
    const rows: EvaluationAttempt[] = [];
    for (const [id, permit] of this.permits) {
      if (permit.caseId !== caseId || permit.locale !== locale) continue;
      const receipt = this.receipts.get(id);
      if (!receipt) continue;
      rows.push({
        section: permit.section as SectionKey,
        phase: permit.phase,
        state: receipt.basis,
        model: permit.model,
        reportedModel: receipt.model,
        reservedMicros: permit.reservedMicros,
        costMicros: receipt.costMicros,
        inputTokens: receipt.usage?.inputTokens ?? null,
        outputTokens: receipt.usage?.outputTokens ?? null,
        latencyMs: receipt.latencyMs,
        code: receipt.code,
        outcome: receipt.outcome?.kind ?? null,
      });
    }
    return rows;
  }

  get exposure() {
    return this.exposureMicros;
  }

  close() {
    this.releaseLock();
  }

  async admit(permit: { section: SectionKey; phase: "primary" | "repair"; model: string; reservedMicros: number }) {
    if (!this.sample) throw new GenerationBlocked("accounting_unavailable");
    const quote = this.quotes[permit.model];
    if (quote === undefined || quote !== permit.reservedMicros) throw new GenerationBlocked("pricing_unavailable");
    for (const existing of this.permits.values()) {
      if (existing.caseId !== this.sample.caseId || existing.locale !== this.sample.locale) continue;
      if (existing.section === permit.section && existing.phase === permit.phase) throw new GenerationBlocked("attempt_already_admitted");
    }
    const projected = this.exposureMicros + permit.reservedMicros;
    if (projected > this.ceilingMicros) throw new GenerationBlocked("cost_ceiling");
    const record = permitRecordSchema.parse({
      type: "permit",
      id: randomUUID(),
      caseId: this.sample.caseId,
      locale: this.sample.locale,
      section: permit.section,
      phase: permit.phase,
      model: permit.model,
      reservedMicros: permit.reservedMicros,
    });
    appendJsonLine(this.ledgerPath, record);
    this.permits.set(record.id, record);
    this.recomputeExposure();
    return record.id;
  }

  async assertPermit(id: string) {
    if (!this.permits.has(id) || this.receipts.has(id)) throw new GenerationBlocked("permit_missing");
  }

  async settle(id: string, settlement: AttemptSettlement) {
    const permit = this.permits.get(id);
    if (!permit) throw new GenerationBlocked("permit_missing");
    const existing = this.receipts.get(id);
    if (existing) return this.exposureMicros;
    validateAttemptSettlement(settlement, permit.reservedMicros, this.settings, permit.model, this.admitsModel);
    const record = receiptRecordSchema.parse({
      type: "receipt",
      id,
      basis: settlement.basis,
      costMicros: settlement.costMicros,
      model: settlement.model,
      usage: settlement.usage,
      latencyMs: settlement.latencyMs,
      code: settlement.code,
      outcome: settlement.outcome ?? null,
    });
    appendJsonLine(this.ledgerPath, record);
    this.receipts.set(id, record);
    this.recomputeExposure();
    return this.exposureMicros;
  }

  private recomputeExposure() {
    let total = 0;
    for (const [id, permit] of this.permits) {
      const receipt = this.receipts.get(id);
      total += receipt ? receipt.costMicros : permit.reservedMicros;
    }
    this.exposureMicros = total;
  }
}

function sampleSection(section: SectionKey, locale: Locale, output: SectionOutput): EvaluationSample["sections"][number] {
  return {
    key: section,
    title: PAID_SECTION_TITLES[section][locale],
    status: "generated",
    blocks: output.blocks,
    ...(output.closingQuestion ? { closingQuestion: output.closingQuestion } : {}),
  };
}

function failedSection(section: SectionKey, locale: Locale): EvaluationSample["sections"][number] {
  return { key: section, title: PAID_SECTION_TITLES[section][locale], status: "failed", blocks: [] };
}

function repairPrompt(prompt: string) {
  return `${prompt}\n\nThe previous response failed the section schema. Return a corrected JSON object satisfying the schema. No commentary outside the JSON.`;
}

async function runSample(
  deps: SamplingDeps,
  ledger: SamplingLedger,
  corpus: SamplingCorpus,
  caseId: string,
  locale: Locale,
): Promise<{ sample: EvaluationSample; budgetExhausted: boolean }> {
  const digest = corpus.facts[caseId];
  if (!digest) throw new SamplingError("sampling_case_unknown");
  ledger.beginSample(caseId, locale);
  try {
    const sections: EvaluationSample["sections"] = [];
    let failed = false;
    let budgetExhausted = false;
    const noteHalt = (halt: string | undefined) => {
      if (halt?.startsWith("cost_ceiling")) budgetExhausted = true;
    };
    for (const section of deps.config.sections) {
      const valid = ledger.validOutcome(caseId, locale, section);
      if (valid) {
        sections.push(sampleSection(section, locale, valid));
        continue;
      }
      if (failed) {
        sections.push(failedSection(section, locale));
        continue;
      }
      const primary = ledger.receiptFor(caseId, locale, section, "primary");
      const repair = ledger.receiptFor(caseId, locale, section, "repair");
      if (primary && !primary.outcome) {
        // Unknown/not_dispatched/measured-without-checkpoint: stop, never replay.
        failed = true;
        sections.push(failedSection(section, locale));
        continue;
      }
      const schema = sectionJsonSchema(section, "paid");
      const prompt = assembleSectionPrompt(section, locale, JSON.stringify(digest, null, 1), JSON.stringify(schema), "paid");
      const model = deps.config.settings.models[SECTION_MODEL_TIER[section]];
      const request = { section, locale, prompt, digest, jsonSchema: schema, model, maxOutputTokens: MAX_OUTPUT_TOKENS_PER_SECTION };
      const validate = (output: unknown) => validateSectionOutput(section, output, "paid");
      let output: SectionOutput | null = null;

      if (primary?.outcome?.kind === "invalid") {
        if (repair) {
          failed = true;
        } else {
          const repaired = await dispatchAttempt(ledger, deps.provider, { ...request, prompt: repairPrompt(prompt) }, "repair", validate);
          noteHalt(repaired.halt);
          if (repaired.halt || !repaired.completion) failed = true;
          else {
            const checked = validate(repaired.completion.output);
            if (checked.ok) output = checked.value;
            else failed = true;
          }
        }
      } else if (!primary) {
        const attempted = await dispatchAttempt(ledger, deps.provider, request, "primary", validate);
        noteHalt(attempted.halt);
        if (attempted.halt || !attempted.completion) failed = true;
        else {
          const checked = validate(attempted.completion.output);
          if (checked.ok) output = checked.value;
          else {
            const repaired = await dispatchAttempt(ledger, deps.provider, { ...request, prompt: repairPrompt(prompt) }, "repair", validate);
            noteHalt(repaired.halt);
            if (repaired.halt || !repaired.completion) failed = true;
            else {
              const rechecked = validate(repaired.completion.output);
              if (rechecked.ok) output = rechecked.value;
              else failed = true;
            }
          }
        }
      } else {
        failed = true;
      }

      if (output) sections.push(sampleSection(section, locale, output));
      else {
        failed = true;
        sections.push(failedSection(section, locale));
      }
    }
    return { sample: { caseId, locale, factsHash: canonicalHash(digest), sections, attempts: ledger.attemptsFor(caseId, locale) }, budgetExhausted };
  } finally {
    ledger.endSample();
  }
}

function loadReport(path: string, deps: SamplingDeps): PaidEvaluationReport | null {
  if (!existsSync(path)) return null;
  const parsed = paidEvaluationSchema.safeParse(readJson(path));
  if (!parsed.success) throw new SamplingError("sampling_output_invalid");
  const report = parsed.data;
  if (report.source !== "provider" || report.profile !== deps.config.editionProfile ||
    report.configHash !== deps.config.fingerprint || report.contentVersion !== deps.config.contentVersion ||
    report.corpusHash !== deps.corpus.corpusHash) throw new SamplingError("sampling_output_exists");
  if (report.samples.some(sample => sample.sections.some(section => section.status !== "generated"))) {
    throw new SamplingError("sampling_sample_incomplete");
  }
  return report;
}

/**
 * Run the bounded pilot. The caller supplies the already-validated paid config,
 * the frozen corpus and the provider; this function never reads process.env.
 */
export async function runGenuineSampling(deps: SamplingDeps, options: SamplingOptions): Promise<SamplingResult> {
  if (options.cases.length === 0 || options.capMicros <= 0) throw new SamplingError("sampling_authorization_missing");
  for (const id of options.cases) {
    if (!deps.corpus.cases.some(entry => entry.id === id)) throw new SamplingError("sampling_case_unknown");
  }
  const ledger = SamplingLedger.open(options, deps.config);
  const reportPath = join(options.outputDir, "report.json");
  try {
    ledger.assertResumable();
    const existing = loadReport(reportPath, deps);
    // "Cannot complete", not "has attempts": a mid-sample crash must resume, while
    // a terminal receipt (invalid/unknown/not_dispatched) must refuse before any
    // call. sampleState is the same predicate runSample uses per section.
    for (const id of options.cases) {
      if (ledger.sampleState(id, options.locale, deps.config.sections) === "blocked") {
        throw new SamplingError("sampling_sample_incomplete");
      }
    }
    const report: PaidEvaluationReport = existing ?? {
      version: PAID_EVALUATION_VERSION,
      corpusVersion: PAID_CORPUS_VERSION,
      corpusHash: deps.corpus.corpusHash,
      source: "provider",
      profile: deps.config.editionProfile,
      contentVersion: deps.config.contentVersion,
      configHash: deps.config.fingerprint,
      processor: deps.config.profile.name,
      models: deps.config.settings.models,
      schemaHash: deps.corpus.schemaHash,
      promptHashes: deps.corpus.promptHashes,
      facts: deps.corpus.facts,
      samples: [],
    };
    for (const id of options.cases) {
      if (report.samples.some(sample => sample.caseId === id && sample.locale === options.locale)) continue;
      const { sample, budgetExhausted } = await runSample(deps, ledger, deps.corpus, id, options.locale);
      report.samples.push(sample);
      writeJsonAtomic(reportPath, paidEvaluationSchema.parse(report));
      if (budgetExhausted) throw new SamplingError("sampling_budget_exhausted");
      if (sample.sections.some(section => section.status !== "generated")) throw new SamplingError("sampling_sample_incomplete");
    }
    return { report, reportPath, exposureMicros: ledger.exposure, ledgerPath: ledger.ledgerPath };
  } finally {
    ledger.close();
  }
}
