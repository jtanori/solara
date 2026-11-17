import { createHash } from "node:crypto";
import { z } from "zod";
import { costMicros, generationSettings, type GenerationSettings } from "@/readings/execution";
import { MAX_OUTPUT_TOKENS_PER_SECTION, TIER_CEILING_MXN } from "@/readings/config";
import { createChatAdapter } from "@/readings/adapters/chat-completions";
import type { ReadingProvider } from "@/readings/provider";
import type { Locale } from "@/lib/i18n";

export const GENERATION_RUN_MS = 45_000;
export const GENERATION_DISPATCH_MS = 40_000;
export const PAYLOAD_POLICY_REVISION = "derived-chart-v1";
export const RICH_PAYLOAD_POLICY_REVISION = "derived-chart-annual-v2";
const modelId = z.string().regex(/^[a-zA-Z0-9._:/-]{1,128}$/).refine(value => value !== "__proto__");
const profileSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().trim().min(1).max(100),
  policyVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  inputTokenLimits: z.record(modelId, z.number().int().min(1).max(2_000_000)),
  servedModels: z.record(modelId, z.array(modelId).min(1).max(10)),
});
export type ProcessorProfile = z.infer<typeof profileSchema> & { baseUrl: string; policyHash: string; payloadPolicy: typeof PAYLOAD_POLICY_REVISION | typeof RICH_PAYLOAD_POLICY_REVISION };
export type ConsentDescriptor = { processorId: string; providerName: string; policyVersion: string; policyHash: string; disclosure: string };
export type LiveGenerationConfig = { profile: ProcessorProfile; settings: GenerationSettings; provider: ReadingProvider; fingerprint: string };

export function processorProfile(env: Record<string, string | undefined> = process.env): ProcessorProfile | null {
  try {
    if (env.READINGS_PROVIDER !== "chat-completions" || !env.READINGS_PROCESSOR_PROFILE || env.READINGS_PROCESSOR_PROFILE.length > 16_384) return null;
    const parsed = profileSchema.parse(JSON.parse(env.READINGS_PROCESSOR_PROFILE));
    const url = new URL(env.READINGS_API_BASE_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    const baseUrl = url.href.replace(/\/+$/, "");
    // Selecting richer facts materially broadens the disclosure and invalidates
    // old consent receipts. Unknown paid configuration never breaks free setup.
    const payloadPolicy = env.READINGS_PAID_PROFILE === "paid-rich-v1" ? RICH_PAYLOAD_POLICY_REVISION : PAYLOAD_POLICY_REVISION;
    const policyHash = hash({ id: parsed.id, name: parsed.name, version: parsed.policyVersion, baseUrl, payload: payloadPolicy });
    return { ...parsed, baseUrl, policyHash, payloadPolicy };
  } catch { return null; }
}

export function consentDescriptor(profile: ProcessorProfile, locale: Locale): ConsentDescriptor {
  return {
    processorId: profile.id, providerName: profile.name, policyVersion: profile.policyVersion, policyHash: profile.policyHash,
    disclosure: locale === "es"
      ? `Para generar tu interpretación, Solara enviará a ${profile.name} posiciones, signos, casas y aspectos derivados de tu carta.${profile.payloadPolicy === RICH_PAYLOAD_POLICY_REVISION ? " Las ediciones ampliadas de pago también envían posiciones y ángulos natales derivados, tu edad cumplida en el año elegido, la profección tradicional y aspectos de tránsito calculados en el instante del retorno solar. No se envían marcas de tiempo natales ni del retorno." : ""} No enviará tu nombre, correo, fecha u hora de nacimiento, lugar ni coordenadas. Los datos derivados no son necesariamente anónimos. Puedes retirar el consentimiento para impedir nuevas solicitudes; una solicitud ya autorizada podría terminar. Las lecturas guardadas se conservan hasta que las elimines.`
      : `To generate your interpretation, Solara will send ${profile.name} derived chart positions, signs, houses and aspects.${profile.payloadPolicy === RICH_PAYLOAD_POLICY_REVISION ? " Expanded paid editions also send derived natal positions and angles, your age attained in the selected year, the traditional annual profection and transit aspects calculated at the solar-return instant. Natal and return timestamps are not sent." : ""} It will not send your name, email, birth date or time, location or coordinates. Derived data is not necessarily anonymous. You can withdraw consent to stop new requests; an already authorized request may finish. Saved readings remain until you delete them.`,
  };
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** No fixture/model/price fallback for a real account. All values stay server-side. */
export function liveGenerationConfig(fetchImpl?: typeof fetch): LiveGenerationConfig | null {
  const profile = processorProfile();
  const rawKey = process.env.READINGS_API_KEY;
  const apiKey = rawKey?.trim();
  // Reject control/non-ASCII bytes before trimming; a CR/LF suffix must not
  // become acceptable. Bearer keys contain visible ASCII, without whitespace.
  if (!rawKey || /[^\x20-\x7e]/.test(rawKey) || !apiKey || /[^\x21-\x7e]/.test(apiKey)) return null;
  if (!profile || !process.env.READINGS_CHEAP_MODEL || !process.env.READINGS_MODEL_PRICES) return null;
  const settings = generationSettings();
  const requested = settings.models.cheap;
  if (requested === "fixture-1" || !Object.hasOwn(profile.inputTokenLimits, requested) || !Object.hasOwn(profile.servedModels, requested) || !settings.prices) return null;
  const served = profile.servedModels[requested];
  if (!served?.length) return null;
  for (const model of [requested, ...served]) {
    const price = Object.hasOwn(settings.prices, model) ? settings.prices[model] : null;
    if (!price || price.inputMxnPerMillion <= 0 || price.outputMxnPerMillion <= 0) return null;
    const requestedPrice = settings.prices[requested];
    // Aliases currently must share the requested model's billing rates.
    if (!requestedPrice || price.inputMxnPerMillion !== requestedPrice.inputMxnPerMillion || price.outputMxnPerMillion !== requestedPrice.outputMxnPerMillion) return null;
  }
  const quote = costMicros(settings.prices, requested, {
    inputTokens: profile.inputTokenLimits[requested], outputTokens: MAX_OUTPUT_TOKENS_PER_SECTION,
  });
  if (quote === null || quote > Math.round(TIER_CEILING_MXN.free * 1_000_000)) return null;
  try {
    const provider = createChatAdapter({
      baseUrl: profile.baseUrl, apiKey,
      inputTokenLimits: profile.inputTokenLimits, fetchImpl,
      timeoutMs: process.env.READINGS_REQUEST_TIMEOUT_MS ? Number(process.env.READINGS_REQUEST_TIMEOUT_MS) : undefined,
    });
    return { profile, settings, provider, fingerprint: hash({ profile, settings, payload: profile.payloadPolicy }) };
  } catch { return null; }
}

/** Stable across JSONB's object-key ordering; array order remains significant. */
export function canonicalHash(value: unknown): string {
  const ordered = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(ordered)
    : entry !== null && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]))
      : entry;
  return hash(ordered(value));
}
