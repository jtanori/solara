import { createHash } from "node:crypto";
import { z } from "zod";
import { generationSettings, type GenerationSettings } from "@/readings/execution";
import { createChatAdapter } from "@/readings/adapters/chat-completions";
import type { ReadingProvider } from "@/readings/provider";
import type { Locale } from "@/lib/i18n";

export const GENERATION_RUN_MS = 45_000;
export const GENERATION_DISPATCH_MS = 40_000;
export const PAYLOAD_POLICY_REVISION = "derived-chart-v1";
const modelId = z.string().regex(/^[a-zA-Z0-9._:/-]{1,128}$/).refine(value => value !== "__proto__");
const profileSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().trim().min(1).max(100),
  policyVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  inputTokenLimits: z.record(modelId, z.number().int().min(1).max(2_000_000)),
  servedModels: z.record(modelId, z.array(modelId).min(1).max(10)),
});
export type ProcessorProfile = z.infer<typeof profileSchema> & { baseUrl: string; policyHash: string };
export type ConsentDescriptor = { processorId: string; providerName: string; policyVersion: string; policyHash: string; disclosure: string };
export type LiveGenerationConfig = { profile: ProcessorProfile; settings: GenerationSettings; provider: ReadingProvider; fingerprint: string };

export function processorProfile(env: Record<string, string | undefined> = process.env): ProcessorProfile | null {
  try {
    if (env.READINGS_PROVIDER !== "chat-completions" || !env.READINGS_PROCESSOR_PROFILE || env.READINGS_PROCESSOR_PROFILE.length > 16_384) return null;
    const parsed = profileSchema.parse(JSON.parse(env.READINGS_PROCESSOR_PROFILE));
    const url = new URL(env.READINGS_API_BASE_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    const baseUrl = url.href.replace(/\/+$/, "");
    const policyHash = hash({ id: parsed.id, name: parsed.name, version: parsed.policyVersion, baseUrl, payload: PAYLOAD_POLICY_REVISION });
    return { ...parsed, baseUrl, policyHash };
  } catch { return null; }
}

export function consentDescriptor(profile: ProcessorProfile, locale: Locale): ConsentDescriptor {
  return {
    processorId: profile.id, providerName: profile.name, policyVersion: profile.policyVersion, policyHash: profile.policyHash,
    disclosure: locale === "es"
      ? `Para generar tu interpretación, Solara enviará a ${profile.name} posiciones, signos, casas y aspectos derivados de tu carta. No enviará tu nombre, correo, fecha u hora de nacimiento, lugar ni coordenadas. Los datos derivados no son necesariamente anónimos. Puedes retirar el consentimiento para impedir nuevas solicitudes; una solicitud ya autorizada podría terminar. Las lecturas guardadas se conservan hasta que las elimines.`
      : `To generate your interpretation, Solara will send ${profile.name} derived chart positions, signs, houses and aspects. It will not send your name, email, birth date or time, location or coordinates. Derived data is not necessarily anonymous. You can withdraw consent to stop new requests; an already authorized request may finish. Saved readings remain until you delete them.`,
  };
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** No fixture/model/price fallback for a real account. All values stay server-side. */
export function liveGenerationConfig(fetchImpl?: typeof fetch): LiveGenerationConfig | null {
  const profile = processorProfile();
  if (!profile || !process.env.READINGS_API_KEY || !process.env.READINGS_CHEAP_MODEL || !process.env.READINGS_MODEL_PRICES) return null;
  const settings = generationSettings();
  const requested = settings.models.cheap;
  const served = profile.servedModels[requested];
  if (requested === "fixture-1" || !Object.hasOwn(profile.inputTokenLimits, requested) || !served?.length || !settings.prices) return null;
  for (const model of [requested, ...served]) {
    const price = Object.hasOwn(settings.prices, model) ? settings.prices[model] : null;
    if (!price || price.inputMxnPerMillion <= 0 || price.outputMxnPerMillion <= 0) return null;
    const requestedPrice = settings.prices[requested];
    // Aliases currently must share the requested model's billing rates.
    if (!requestedPrice || price.inputMxnPerMillion !== requestedPrice.inputMxnPerMillion || price.outputMxnPerMillion !== requestedPrice.outputMxnPerMillion) return null;
  }
  try {
    const provider = createChatAdapter({
      baseUrl: profile.baseUrl, apiKey: process.env.READINGS_API_KEY,
      inputTokenLimits: profile.inputTokenLimits, fetchImpl,
      timeoutMs: process.env.READINGS_REQUEST_TIMEOUT_MS ? Number(process.env.READINGS_REQUEST_TIMEOUT_MS) : undefined,
    });
    return { profile, settings, provider, fingerprint: hash({ profile, settings, payload: PAYLOAD_POLICY_REVISION }) };
  } catch { return null; }
}
