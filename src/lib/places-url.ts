export function buildUpstreamUrl(name: string, language: "en" | "es", apiKey: string | undefined): URL {
  const url = new URL(apiKey ? "https://customer-geocoding-api.open-meteo.com/v1/search" : "https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", name);
  url.searchParams.set("count", "6");
  url.searchParams.set("language", language);
  url.searchParams.set("format", "json");
  if (apiKey) url.searchParams.set("apikey", apiKey);
  return url;
}
