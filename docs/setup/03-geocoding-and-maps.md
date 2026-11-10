# 3. Geocoding and map selector

## What is implemented

City search is proxied through `/api/places` to Open-Meteo, returning coordinates and an IANA time zone. The route requires a same-origin request, is limited to 30 requests/minute per IP, caches identical `(query, language)` responses in a bounded per-instance server cache, caps concurrent upstream calls, and enforces the shared `PLACES_HOURLY_BUDGET` upstream calls per hour before failing closed with `503`. Exhausting the budget affects all users until the next hour. The map uses React Leaflet and OpenStreetMap tiles by default; clicking a point derives a current IANA zone with `tz-lookup`. Manual coordinates and zone entry remain available. The map does not reverse-geocode a clicked point into a city name. Current geographic zone boundaries are **not** a guarantee of historical correctness.

## Variables

- `PLACES_HOURLY_BUDGET` is the maximum upstream geocoding calls per hour (default `1000`). When exhausted, `/api/places` returns `503` until the next window; the API key and upstream URL are never logged.
- `OPEN_METEO_API_KEY` is optional and **server-side only**. When set, the server calls Open-Meteo's customer geocoding endpoint with the key; when absent, it uses the public non-commercial endpoint. A failed customer request does not silently fall back to the public endpoint.
- `NEXT_PUBLIC_MAP_TILE_URL` is an optional HTTPS tile URL template containing `{z}`, `{x}`, and `{y}`. It is included in the browser bundle at build time. Use only a provider-authorized public/restricted browser key, never a private secret.
- `NEXT_PUBLIC_MAP_ATTRIBUTION` is optional plain-text provider attribution. The app always shows the OpenStreetMap contributor link as well; verify that the chosen provider's full attribution requirements are met. Values are escaped before insertion into the map.

## Local setup

1. No key is needed for non-commercial evaluation. Run the app and test `/api/places?q=Merida&lang=es`; it should return matching locations and time zones. Test a city in English too.
2. In onboarding, search and select a location, choose another point on the map, zoom/pan, and test manual coordinates. Confirm the displayed zone and latitude/longitude before continuing.
3. Optional: set a permitted tile URL and attribution, restart the development server and repeat. With an Open-Meteo customer key, set `OPEN_METEO_API_KEY` server-side and verify customer-service access; do not print the upstream request URL because it contains the key.

## Staging setup

1. Use a staging-specific Open-Meteo customer key where commercial usage requires one. Set staging Preview variables, including a staging-safe public tile URL and attribution if using a provider. Redeploy after `NEXT_PUBLIC_*` changes.
2. Test the city search in both languages, duplicate city names, map selection, manual fallback, provider failure, and time-zone transitions with synthetic data. Review the zone suggested at boundaries and for historical birth dates.
3. Ensure browser referrer/attribution requirements and provider quotas are met. Watch `/api/places` rate-limit and budget logs, and keep the public OpenStreetMap tile service within its policy; do not bulk-download or prefetch tiles.

## Production setup

1. Obtain an appropriate commercial Open-Meteo license/key or implement another properly licensed geocoder. Set `OPEN_METEO_API_KEY` only in the production server secret manager. Review provider retention, location-data processing and terms.
2. Choose a production tile provider with suitable capacity, terms and attribution. Set its public URL template and attribution in production and redeploy; restrict any public browser key to the production domain at the provider. Never put a secret key in `NEXT_PUBLIC_*`.
3. Monitor geocoding failures and provider limits. Preserve manual entry; independently validate historical time zones, DST gaps/folds and locations near time-zone boundaries before treating results as professional charts.

Sources: [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api), [Open-Meteo pricing](https://open-meteo.com/en/pricing), [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
