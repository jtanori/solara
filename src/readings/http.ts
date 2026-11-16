import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
import { AUTH_RATE_LIMITS, clientIp, consumeBudgets, keyFor, rateLimitedResponse } from "@/lib/rate-limit";
import { log, requestMeta } from "@/lib/log";
import { GenerationStore, type GenerationView } from "@/readings/generation-store";
import { GenerationBlocked } from "@/readings/execution";
import { generationEnabled } from "@/readings/config";
import { consentDescriptor, processorProfile, liveGenerationConfig } from "@/readings/policy";
import { generateFreeReading, type GenerationServiceDeps } from "@/readings/generation-service";
import type { Locale } from "@/lib/i18n";

const uuid = z.string().uuid();
const generationBody = z.strictObject({ locale: z.enum(["en", "es"]) });
const grantBody = z.strictObject({ accepted: z.literal(true), policyHash: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().min(0).max(1_000_000_000) });
type ReadingRateAction = "generate" | "consent" | "delete" | "status";
export type ReadingHttpDeps = GenerationServiceDeps & {
  user?: () => Promise<{ id: string; emailVerifiedAt: Date | null } | null>;
  locale?: Locale;
  throttle?: (request: Request, userId: string, action: ReadingRateAction, locale: Locale) => Promise<Response | null>;
};
const headers = { "Cache-Control": "private, no-store" };
function json(value: unknown, status = 200) { return NextResponse.json(value, { status, headers }); }
function result(value: GenerationView) {
  const response = json(value, value.status === "in_progress" ? 202 : 200);
  if (value.status === "in_progress") response.headers.set("Retry-After", "3");
  return response;
}
async function defaultThrottle(request: Request, userId: string, action: ReadingRateAction, locale: Locale) {
  const policy = action === "generate" ? AUTH_RATE_LIMITS.readingsGenerateUser
    : action === "consent" ? AUTH_RATE_LIMITS.readingsConsentUser
      : action === "delete" ? AUTH_RATE_LIMITS.readingsDeleteUser
        : AUTH_RATE_LIMITS.readingsStatusUser;
  const budgets: Parameters<typeof consumeBudgets>[0] = [{ key: keyFor(`readings:${action}:user`, userId), policy, kind: `readings_${action}_user` }];
  if (action === "generate") budgets.push({ key: keyFor("readings:generate:ip", clientIp(request)), policy: AUTH_RATE_LIMITS.readingsGenerateIp, kind: "readings_generate_ip" });
  const gate = await consumeBudgets(budgets, requestMeta(request));
  return gate.allowed ? null : rateLimitedResponse(locale, gate.retryAfterSeconds);
}
async function identity(request: Request, deps: ReadingHttpDeps, action: ReadingRateAction) {
  const user = await (deps.user ?? currentUser)();
  if (!user?.emailVerifiedAt) return { response: json({ code: "unauthorized" }, 401) };
  const locale = deps.locale ?? await getLocale();
  const limited = await (deps.throttle ?? defaultThrottle)(request, user.id, action, locale);
  if (limited) { limited.headers.set("Cache-Control", "private, no-store"); return { response: limited }; }
  return { user, locale };
}
function failure(request: Request, error: unknown) {
  const code = error instanceof GenerationBlocked ? error.code : "generation_unavailable";
  const status = code === "not_found" ? 404 : code === "unauthorized" ? 401
    : ["invalid_request", "invalid_chart"].includes(code) ? 400
      : ["consent_required", "consent_changed"].includes(code) ? 409 : 503;
  if (status === 503) log.warn("readings.request_unavailable", { ...requestMeta(request), code });
  return json({ code }, status);
}
async function body(request: Request): Promise<unknown> {
  // New endpoints take tiny control messages, never raw chart input.
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 2048) throw new GenerationBlocked("invalid_request");
  const reader = request.body?.getReader();
  if (!reader) throw new GenerationBlocked("invalid_request");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) throw new GenerationBlocked("invalid_request");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new GenerationBlocked("invalid_request"); }
  finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function handleConsent(request: Request, deps: ReadingHttpDeps = {}) {
  try {
    const identified = await identity(request, deps, request.method === "GET" ? "status" : "consent");
    if (identified.response) return identified.response;
    const { user, locale } = identified;
    const store = deps.store ?? new GenerationStore();
    if (request.method === "DELETE") {
      const saved = await store.withdraw(user.id, locale);
      return json({ revision: saved.revision, active: false });
    }
    const profile = processorProfile();
    const enabled = (deps.enabled ?? generationEnabled)();
    const available = enabled && Boolean((deps.config ?? liveGenerationConfig)());
    if (request.method === "GET") {
      const saved = await store.consent(user.id);
      return json({
        available, policy: profile ? consentDescriptor(profile, locale) : null,
        revision: saved?.revision ?? 0,
        active: Boolean(saved?.grantedAt && !saved.withdrawnAt && saved.policyHash === profile?.policyHash),
        hasConsent: Boolean(saved?.grantedAt && !saved.withdrawnAt),
      });
    }
    if (request.method !== "PUT") return json({ code: "method_not_allowed" }, 405);
    const parsed = grantBody.safeParse(await body(request));
    if (!parsed.success) throw new GenerationBlocked("invalid_request");
    if (!enabled) throw new GenerationBlocked("generation_disabled");
    if (!profile || !available) throw new GenerationBlocked("generation_unavailable");
    if (parsed.data.policyHash !== profile.policyHash) throw new GenerationBlocked("consent_changed");
    const saved = await store.grant(user.id, profile, parsed.data.expectedRevision, locale);
    return json({ revision: saved.revision, active: true });
  } catch (error) { return failure(request, error); }
}

export async function handleGeneration(request: Request, readingId: string, deps: ReadingHttpDeps = {}) {
  try {
    const identified = await identity(request, deps, request.method === "GET" ? "status" : "generate");
    if (identified.response) return identified.response;
    if (!uuid.safeParse(readingId).success) throw new GenerationBlocked("invalid_chart");
    if (request.method === "GET") return result(await (deps.store ?? new GenerationStore()).status(identified.user.id, readingId));
    if (request.method !== "POST") return json({ code: "method_not_allowed" }, 405);
    const parsed = generationBody.safeParse(await body(request));
    if (!parsed.success) throw new GenerationBlocked("invalid_request");
    return result(await generateFreeReading(identified.user.id, readingId, parsed.data.locale, request.signal, deps));
  } catch (error) { return failure(request, error); }
}

export async function handleReadingDelete(request: Request, readingId: string, deps: ReadingHttpDeps = {}) {
  try {
    const identified = await identity(request, deps, "delete");
    if (identified.response) return identified.response;
    if (!uuid.safeParse(readingId).success) throw new GenerationBlocked("invalid_chart");
    await (deps.store ?? new GenerationStore()).deleteReading(identified.user.id, readingId);
    return json({ ok: true });
  } catch (error) { return failure(request, error); }
}
