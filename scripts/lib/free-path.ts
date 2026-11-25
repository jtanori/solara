import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db";
import { readingDocuments, readingGenerationRuns as runs, readings, users } from "../../src/db/schema";
import type { ChartInput } from "../../src/lib/types";
import type { Locale } from "../../src/lib/i18n";
import { handleChartSave, type ChartSaveDeps } from "../../src/readings/chart-save";
import { handleConsent, handleGeneration, type ReadingHttpDeps } from "../../src/readings/http";
import { GenerationStore, type GenerationView } from "../../src/readings/generation-store";
import { canonicalHash } from "../../src/readings/canonical-hash";
import { liveGenerationConfig, type LiveGenerationConfig } from "../../src/readings/policy";
import type { ReadingDocument } from "../../src/readings/types";

/**
 * #226 — the free-reading journey on a disposable database.
 *
 * For each corpus case: verified synthetic account → real chart save → explicit consent →
 * explicit generation → persisted document. The provider is injected, so the fixture mode is
 * free and a real-provider mode is a configuration change; the DB, store, handlers and document
 * are always the real ones.
 *
 * The report contains ids, statuses, section keys, versions and hashes — never prose.
 */

export type FreePathCaseReport = {
  id: string;
  locale: Locale;
  readingId: string;
  documentId: string | null;
  status: string;
  sections: { key: string; status: string }[];
  contentVersion: string | null;
  chartVersion: string | null;
  documentHash: string | null;
  costMicros: number;
};

export type FreePathReport = {
  mode: "fixture" | "real";
  locales: Locale[];
  cases: FreePathCaseReport[];
  summary: {
    documents: number;
    completed: number;
    failed: number;
    runsPerUser: number;
    secondGenerationSameDocument: boolean;
  };
};

export type FreePathOptions = {
  corpus: { id: string; input: ChartInput }[];
  locales: Locale[];
  /** Per case, so a test can inject a failing provider without changing the rest. */
  configFor: (caseId: string) => LiveGenerationConfig;
  mode?: "fixture" | "real";
  budgets?: ChartSaveDeps["budgets"];
  keep?: boolean;
  onCase?: (caseId: string, locale: Locale) => void;
};

/** Everything the harness sets in-process for fixture mode. Generation flags are deliberately absent. */
export const FREE_PATH_FIXTURE_ENV: Record<string, string> = {
  READINGS_PROVIDER: "chat-completions",
  READINGS_API_BASE_URL: "https://processor.invalid/v1",
  READINGS_API_KEY: "fake-provider-key",
  READINGS_PROCESSOR_PROFILE: JSON.stringify({
    id: "free-path-synthetic",
    name: "Synthetic fixture processor (harness only)",
    policyVersion: "harness-v1",
    inputTokenLimits: { "fixture-cheap": 6_000, "fixture-strong": 8_000 },
    servedModels: { "fixture-cheap": ["fixture-cheap"], "fixture-strong": ["fixture-strong"] },
  }),
  READINGS_CHEAP_MODEL: "fixture-cheap",
  READINGS_STRONG_MODEL: "fixture-strong",
  READINGS_MODEL_PRICES: JSON.stringify({
    "fixture-cheap": { inputMxnPerMillion: 1, outputMxnPerMillion: 1 },
    "fixture-strong": { inputMxnPerMillion: 1, outputMxnPerMillion: 1 },
  }),
};

/** Applies the fixture environment and returns a restore function. */
export function applyFixtureEnvironment(env: NodeJS.ProcessEnv = process.env): () => void {
  const keys = Object.keys(FREE_PATH_FIXTURE_ENV);
  const saved = Object.fromEntries(keys.map(key => [key, env[key]]));
  Object.assign(env, FREE_PATH_FIXTURE_ENV);
  return () => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}

/** The pipeline reads the global flag directly, so the harness owns it for the run and restores it. */
function enableGenerationForRun(env: NodeJS.ProcessEnv = process.env): () => void {
  const saved = env.READINGS_GENERATION_ENABLED;
  env.READINGS_GENERATION_ENABLED = "true";
  return () => {
    if (saved === undefined) delete env.READINGS_GENERATION_ENABLED;
    else env.READINGS_GENERATION_ENABLED = saved;
  };
}

/**
 * The durable free path requires a metered adapter (`prepare`), so the fixture is a fake
 * transport behind the real chat adapter: deterministic, no network, real metering and limits.
 * `createFixtureProvider` cannot be used here — it has no `prepare`, and the store correctly
 * refuses it as `metering_unavailable`.
 */
export function fixtureFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        model: "fixture-cheap",
        usage: { prompt_tokens: 100, completion_tokens: 100 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                blocks: [{ kind: "prose", text: "Synthetic free-path fixture content." }],
                closingQuestion: "What would you like to reflect on this year?",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
}

/** A transport that always fails, for the "failed generation keeps the offer consumed" case. */
export function failingFetch(): typeof fetch {
  return (async () => new Response("provider unavailable", { status: 500 })) as typeof fetch;
}

export function fixtureConfig(fetchImpl: typeof fetch = fixtureFetch()): LiveGenerationConfig {
  const config = liveGenerationConfig(fetchImpl);
  if (!config) throw new Error("fixture_config_invalid");
  return config;
}

function controlRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/readings", {
    method,
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readView(response: Response): Promise<GenerationView> {
  if (response.status !== 200 && response.status !== 202) {
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    throw new Error(`generation_failed: ${body.code ?? response.status}`);
  }
  return (await response.json()) as GenerationView;
}

async function documentReport(
  id: string,
  locale: Locale,
  readingId: string,
  view: GenerationView,
): Promise<FreePathCaseReport> {
  if (view.status !== "completed" || !view.documentId) {
    return {
      id,
      locale,
      readingId,
      documentId: view.documentId ?? null,
      status: view.status,
      sections: [],
      contentVersion: null,
      chartVersion: null,
      documentHash: null,
      costMicros: 0,
    };
  }
  const [row] = await db.select().from(readingDocuments).where(eq(readingDocuments.id, view.documentId));
  if (!row) throw new Error(`document_missing: ${id}`);
  const document = row.document as ReadingDocument;
  return {
    id,
    locale,
    readingId,
    documentId: view.documentId,
    status: view.status,
    sections: document.sections.map(section => ({ key: section.key, status: section.status })),
    contentVersion: document.contentVersion,
    chartVersion: document.chartVersion,
    documentHash: canonicalHash(document),
    costMicros: Math.round((document.accounting?.measuredMxn ?? document.costMxn ?? 0) * 1_000_000),
  };
}

export async function runFreePathJourney(options: FreePathOptions): Promise<FreePathReport> {
  const store = new GenerationStore();
  const budgets: NonNullable<ChartSaveDeps["budgets"]> =
    options.budgets ?? (async () => ({ allowed: true, retryAfterSeconds: 0 }));
  const createdUsers: string[] = [];
  const userIdByReading = new Map<string, string>();
  const cases: FreePathCaseReport[] = [];
  const restoreFlag = enableGenerationForRun();
  const restoreFixture = (options.mode ?? "fixture") === "fixture" ? applyFixtureEnvironment() : null;

  try {
    for (const locale of options.locales) {
      for (const entry of options.corpus) {
        const config = options.configFor(entry.id);
        const [user] = await db
          .insert(users)
          .values({
            name: "Free path harness",
            email: `synthetic+${randomUUID()}@example.invalid`,
            passwordHash: "not-a-real-hash",
            emailVerifiedAt: new Date(),
          })
          .returning();
        createdUsers.push(user.id);

        const deps: ReadingHttpDeps = {
          user: async () => user,
          locale,
          throttle: async () => null,
          store,
          config: () => config,
          enabled: () => true,
          locales: () => new Set(options.locales),
        };

        const save = await handleChartSave(controlRequest("POST", entry.input), {
          user: async () => user,
          locale,
          budgets,
        });
        if (save.status !== 200) {
          const body = (await save.json().catch(() => ({}))) as { error?: string };
          throw new Error(`chart_save_failed: ${entry.id}: ${body.error ?? save.status}`);
        }
        const { id: readingId } = (await save.json()) as { id: string };
        userIdByReading.set(readingId, user.id);

        const consentResponse = await handleConsent(controlRequest("GET"), deps);
        const consent = (await consentResponse.json()) as { policy?: { policyHash?: string } | null; revision?: number };
        const policyHash = consent.policy?.policyHash;
        if (!policyHash) throw new Error(`consent_unavailable: ${entry.id}`);
        const grant = await handleConsent(
          controlRequest("PUT", { accepted: true, policyHash, expectedRevision: consent.revision ?? 0 }),
          deps,
        );
        if (grant.status !== 200) {
          const body = (await grant.json().catch(() => ({}))) as { code?: string };
          throw new Error(`consent_failed: ${entry.id}: ${body.code ?? grant.status}`);
        }

        let view = await readView(await handleGeneration(controlRequest("POST", { locale }), readingId, deps));
        for (let attempt = 0; attempt < 50 && view.status === "in_progress"; attempt += 1) {
          await delay(100);
          view = await readView(await handleGeneration(controlRequest("GET"), readingId, deps));
        }

        cases.push(await documentReport(entry.id, locale, readingId, view));
        options.onCase?.(entry.id, locale);
      }
    }

    const secondGenerationSameDocument = await secondGenerationHolds(options, cases, userIdByReading, store);
    let runsPerUser = 0;
    for (const userId of createdUsers) {
      const rows = await db.select().from(runs).where(eq(runs.userId, userId));
      runsPerUser = Math.max(runsPerUser, rows.length);
    }

    return {
      mode: options.mode ?? "fixture",
      locales: options.locales,
      cases,
      summary: {
        documents: cases.filter(entry => entry.documentId !== null).length,
        completed: cases.filter(entry => entry.status === "completed").length,
        failed: cases.filter(entry => entry.status !== "completed").length,
        runsPerUser,
        secondGenerationSameDocument,
      },
    };
  } finally {
    if (!options.keep && createdUsers.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUsers));
    }
    restoreFixture?.();
    restoreFlag();
  }
}

/**
 * A second explicit generation must return the document that already exists and must not create
 * a second run: the lifetime offer is one per account.
 */
async function secondGenerationHolds(
  options: FreePathOptions,
  cases: FreePathCaseReport[],
  userIdByReading: Map<string, string>,
  store: GenerationStore,
): Promise<boolean> {
  const first = cases.find(entry => entry.status === "completed" && entry.documentId);
  if (!first) return false;
  const userId = userIdByReading.get(first.readingId);
  if (!userId) return false;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return false;
  const config = options.configFor(first.id);
  const deps: ReadingHttpDeps = {
    user: async () => user,
    locale: first.locale,
    throttle: async () => null,
    store,
    config: () => config,
    enabled: () => true,
    locales: () => new Set(options.locales),
  };
  const again = await readView(
    await handleGeneration(controlRequest("POST", { locale: first.locale }), first.readingId, deps),
  );
  if (again.documentId !== first.documentId) return false;
  const rows = await db.select().from(runs).where(eq(runs.userId, userId));
  return rows.length === 1;
}

/** Deleting a user cascades its readings; used by the cleanup test. */
export async function readingExists(readingId: string): Promise<boolean> {
  const rows = await db.select({ id: readings.id }).from(readings).where(eq(readings.id, readingId));
  return rows.length > 0;
}
