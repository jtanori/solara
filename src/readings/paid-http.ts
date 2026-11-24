import { z } from "zod";
import { GenerationBlocked } from "@/readings/execution";
import { readingControlBody, readingFailure, readingIdentity, readingJson, type ReadingHttpDeps } from "@/readings/http";
import { PaidReadingStore } from "@/readings/paid-store";
import { PAID_PROFILES, ACTIVE_PAID_STATES } from "@/readings/paid-contract";
import { paidGenerationConfig, paidGenerationEnabled, type PaidGenerationConfig } from "@/readings/paid-policy";
import { generationLocales } from "@/readings/config";
import { log, requestMeta } from "@/lib/log";
import type { Locale } from "@/lib/i18n";

const uuid = z.string().uuid();
const intentSchema = z.strictObject({ requestId: uuid, locale: z.enum(["en", "es"]), profile: z.enum(PAID_PROFILES),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), offerHash: z.string().regex(/^[a-f0-9]{64}$/) });
export type PaidHttpDeps = Pick<ReadingHttpDeps, "user" | "locale" | "throttle"> & {
  store?: PaidReadingStore; enabled?: () => boolean; config?: () => PaidGenerationConfig | null;
  locales?: () => Set<Locale>;
};

/** Accept durable intent only. There is intentionally no worker/provider import here. */
export async function handlePaidReading(request: Request, readingId: string, deps: PaidHttpDeps = {}) {
  try {
    const identified = await readingIdentity(request, deps, request.method === "GET" ? "status" : "generate");
    if (identified.response) return identified.response;
    if (!uuid.safeParse(readingId).success) throw new GenerationBlocked("invalid_chart");
    const store = deps.store ?? new PaidReadingStore();
    const getConfig = deps.config ?? paidGenerationConfig;
    const enabled = deps.enabled ?? paidGenerationEnabled;
    const locales = deps.locales ?? generationLocales;
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams;
      for (const key of query.keys()) if (!["locale", "cursor"].includes(key) || query.getAll(key).length !== 1) throw new GenerationBlocked("invalid_request");
      const locale = query.get("locale") ?? identified.locale;
      if (locale !== "en" && locale !== "es") throw new GenerationBlocked("invalid_request");
      const cursor = query.get("cursor") ?? undefined;
      if (cursor && !uuid.safeParse(cursor).success) throw new GenerationBlocked("invalid_request");
      // An unqualified locale is not offered at all, so the client shows no actionable
      // control instead of a button the server will refuse (#224).
      return readingJson(await store.offer(identified.user.id, readingId, locale, getConfig(), enabled() && locales().has(locale), cursor));
    }
    if (request.method !== "POST") return readingJson({ code: "method_not_allowed" }, 405);
    const parsed = intentSchema.safeParse(await readingControlBody(request));
    if (!parsed.success) throw new GenerationBlocked("invalid_request");
    const previous = await store.existingIntent(identified.user.id, readingId, parsed.data.requestId);
    if (previous) return readingJson(previous, ACTIVE_PAID_STATES.includes(previous.status) ? 202 : 200);
    // #224: refuse before any durable intent, allowance or permit exists for that locale.
    if (!locales().has(parsed.data.locale)) {
      log.warn("readings.locale_not_qualified", { ...requestMeta(request), userId: identified.user.id, readingId });
      throw new GenerationBlocked("paid_unavailable");
    }
    const config = getConfig();
    if (!enabled() || !config) throw new GenerationBlocked("paid_unavailable");
    const view = await store.accept(identified.user.id, readingId, parsed.data, config, () => {
      const latest = getConfig();
      return enabled() && latest?.fingerprint === config.fingerprint && latest.contentVersion === config.contentVersion;
    });
    const response = readingJson(view, 202);
    response.headers.set("Retry-After", "3");
    return response;
  } catch (error) { return readingFailure(request, error); }
}

export async function handlePaidStop(request: Request, readingId: string, runId: string, deps: PaidHttpDeps = {}) {
  try {
    const identified = await readingIdentity(request, deps, "delete");
    if (identified.response) return identified.response;
    if (!uuid.safeParse(readingId).success || !uuid.safeParse(runId).success) throw new GenerationBlocked("invalid_request");
    if (request.method !== "POST") return readingJson({ code: "method_not_allowed" }, 405);
    if (!z.strictObject({}).safeParse(await readingControlBody(request)).success) throw new GenerationBlocked("invalid_request");
    return readingJson(await (deps.store ?? new PaidReadingStore()).stop(identified.user.id, readingId, runId));
  } catch (error) { return readingFailure(request, error); }
}
