import { NextResponse } from "next/server";
import {
  evaluateMutationOrigin,
  vercelOrigins,
} from "@/lib/request-security";
import {
  AUTH_RATE_LIMITS,
  clientIp,
  consumeRateLimit,
  keyFor,
} from "@/lib/rate-limit";
import { getCachedPlaces, setCachedPlaces } from "@/lib/places-cache";
import { Semaphore, SemaphoreQueueFullError } from "@/lib/semaphore";
import { log, requestMeta } from "@/lib/log";
import { buildUpstreamUrl } from "@/lib/places-url";

type GeocodingResult = {
  name?: string;
  admin1?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
};

type PlacesDeps = {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
};

const upstreamSlots = new Semaphore(4, 32);

function hourlyBudget(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.PLACES_HOURLY_BUDGET ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}

function tooMany(retryAfterSeconds: number) {
  return NextResponse.json(
    { places: [], error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) } },
  );
}

export async function handlePlaces(request: Request, deps: PlacesDeps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const params = new URL(request.url).searchParams;
  const name = params.get("q")?.trim() ?? "";
  const language = params.get("lang") === "es" ? "es" : "en";
  if (name.length < 2 || name.length > 100) return NextResponse.json({ places: [] });
  const context = requestMeta(request);

  const origin = evaluateMutationOrigin({
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    appUrl: env.APP_URL,
    requestUrl: request.url,
    trustedOrigins: vercelOrigins(env),
  });
  if (!origin.allowed) {
    return NextResponse.json({ places: [], error: "forbidden" }, { status: 403 });
  }

  const ipLimit = await consumeRateLimit(
    keyFor("places:ip", clientIp(request)),
    AUTH_RATE_LIMITS.placesIp,
    "places_ip",
    context,
  );
  if (!ipLimit.allowed) return tooMany(ipLimit.retryAfterSeconds);

  const cacheKey = `${name}\u0000${language}`;
  const cached = getCachedPlaces(cacheKey);
  if (cached) return NextResponse.json({ places: cached });

  const apiKey = env.OPEN_METEO_API_KEY?.trim();
  const budgetKey = keyFor("places:budget", new Date().toISOString().slice(0, 13));
  const budget = await consumeRateLimit(
    budgetKey,
    { limit: hourlyBudget(env), windowSeconds: 60 * 60 },
    "places_budget",
    context,
  );
  if (!budget.allowed) {
    log.warn("places.budget_exceeded", { ...context, retryAfterSeconds: budget.retryAfterSeconds });
    return NextResponse.json({ places: [], error: "unavailable" }, { status: 503 });
  }

  try {
    await upstreamSlots.acquire();
  } catch (error) {
    if (error instanceof SemaphoreQueueFullError) {
      return NextResponse.json({ places: [], error: "busy" }, { status: 503 });
    }
    throw error;
  }

  try {
    const url = buildUpstreamUrl(name, language, apiKey);
    const response = await (deps.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Geocoding unavailable");

    const data = await response.json() as { results?: GeocodingResult[] };
    const places = (data.results ?? [])
      .filter((place) => typeof place.timezone === "string")
      .map((place) => ({
        name: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
        latitude: Number(place.latitude),
        longitude: Number(place.longitude),
        timezone: place.timezone as string,
      }))
      .filter((place) => Number.isFinite(place.latitude) && Number.isFinite(place.longitude));

    setCachedPlaces(cacheKey, places, apiKey ? 60 * 60 : 24 * 60 * 60);
    return NextResponse.json({ places });
  } catch (error) {
    log.error("places.fetch_failed", { ...context, category: "upstream_error" });
    return NextResponse.json({ places: [], error: "unavailable" }, { status: 503 });
  } finally {
    upstreamSlots.release();
  }
}
