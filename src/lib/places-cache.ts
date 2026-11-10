export type PlaceResult = {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

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
