export type PlaceResult = {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

/**
 * Cache identity for a place query. The locale belongs in the key: upstream returns
 * language-specific names (Munich/Múnich), so one entry per (name, language). Kept
 * here, next to the store it keys, so the composition is unit-testable without a
 * database — the handler only reaches the cache after two rate-limit calls.
 */
export function placesCacheKey(name: string, language: "en" | "es"): string {
  return `${name}\u0000${language}`;
}

type CacheEntry = {
  value: PlaceResult[];
  expiresAt: number;
};

const MAX_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();

export function getCachedPlaces(key: string): PlaceResult[] | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value.map((place) => ({ ...place }));
}

export function setCachedPlaces(key: string, value: PlaceResult[], ttlSeconds: number): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, {
    value: value.map((place) => ({ ...place })),
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

export function clearPlacesCacheForTests(): void {
  cache.clear();
}
