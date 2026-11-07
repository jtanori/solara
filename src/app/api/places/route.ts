import { NextResponse } from "next/server";

type GeocodingResult = { name: string; admin1?: string; country?: string; latitude: number; longitude: number; timezone?: string };
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const name = params.get("q")?.trim() ?? "";
  const language = params.get("lang") === "es" ? "es" : "en";
  if (name.length < 2 || name.length > 100) return NextResponse.json({ places: [] });
  try {
    const apiKey = process.env.OPEN_METEO_API_KEY?.trim();
    const url = new URL(apiKey ? "https://customer-geocoding-api.open-meteo.com/v1/search" : "https://geocoding-api.open-meteo.com/v1/search");
    url.searchParams.set("name", name); url.searchParams.set("count", "6"); url.searchParams.set("language", language); url.searchParams.set("format", "json");
    if (apiKey) url.searchParams.set("apikey", apiKey);
    // Do not persist keyed request URLs in the application data cache.
    const response = await fetch(url, { signal:AbortSignal.timeout(8000), ...(apiKey ? { cache:"no-store" as const } : { next:{revalidate:86400} }) });
    if (!response.ok) throw new Error("Geocoding unavailable");
    const data = await response.json() as { results?: GeocodingResult[] };
    const places = (data.results ?? []).filter(place => place.timezone).map(place => ({ name:[place.name, place.admin1, place.country].filter(Boolean).join(", "), latitude:place.latitude, longitude:place.longitude, timezone:place.timezone }));
    return NextResponse.json({ places });
  } catch { return NextResponse.json({ places:[], error:"unavailable" }, { status:503 }); }
}
