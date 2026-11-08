import {
  Body, Ecliptic, EclipticLongitude, GeoVector, MakeTime, SearchMoonNode, SunPosition,
} from "astronomy-engine";

/**
 * Pure astronomy helpers. No I/O, no database, no timezone policy — those live in
 * `solar.ts`. Keplerian validity ranges are the reason for the guards here: outside
 * them `astronomy-engine` results degrade silently, and a chart that is confidently
 * wrong is worse than one that refuses.
 */

export type BodyName =
  | "Sun" | "Moon" | "Mercury" | "Venus" | "Mars"
  | "Jupiter" | "Saturn" | "Uranus" | "Neptune" | "Pluto";

export const BODIES: BodyName[] = [
  "Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto",
];

export const SIGN_NAMES = [
  "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
  "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
] as const;

const MAX_BODY_MINUTES = 360; // 6 hours: every body except the Moon moves < 1° in this window

export const DEG = Math.PI / 180;

export function normalize(degrees: number): number {
  const value = degrees % 360;
  return value < 0 ? value + 360 : value;
}

export function signOf(longitude: number): { sign: string; degree: number; index: number } {
  const lon = normalize(longitude);
  const index = Math.floor(lon / 30);
  return { sign: SIGN_NAMES[index], degree: lon - index * 30, index };
}

/**
 * Apparent geocentric ecliptic-of-date longitude, in degrees.
 *
 * The Sun and Moon cannot go through `EclipticLongitude` — that function is heliocentric
 * and throws for the Sun ("Cannot calculate heliocentric longitude of the Sun"). The Sun
 * uses `SunPosition().elon` and the Moon `Ecliptic(GeoVector(Moon))`; the planets use
 * `EclipticLongitude`. All three are geocentric apparent coordinates of date, so they are
 * directly comparable — which is what aspect and house maths depends on.
 */
export function longitudeOf(body: BodyName, date: Date): number {
  const time = MakeTime(date);
  if (body === "Sun") return normalize(SunPosition(time).elon);
  if (body === "Moon") return normalize(Ecliptic(GeoVector(Body.Moon, time, true)).elon);
  return normalize(EclipticLongitude(Body[body], time));
}

/**
 * Daily motion in degrees, by central difference (`±6h`), which is accurate for
 * every supported body and robust around stations. Retrograde is a negative rate.
 * `null` means the body is effectively stationary on that day — typically one day
 * either side of a station — and the caller must not label it retrograde.
 */
export function dailyMotion(body: BodyName, date: Date): number | null {
  const before = date.getTime() - MAX_BODY_MINUTES * 60_000;
  const after = date.getTime() + MAX_BODY_MINUTES * 60_000;
  let delta = longitudeOf(body, new Date(after)) - longitudeOf(body, new Date(before));
  // unwrap across 0/360
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  const perDay = delta / ((after - before) / 86_400_000);
  return Math.abs(perDay) < 0.003 ? null : perDay;
}

export function isRetrograde(body: BodyName, date: Date): boolean | null {
  const motion = dailyMotion(body, date);
  return motion === null ? null : motion < 0;
}

/**
 * True lunar node: the instant the Moon's centre crosses the ecliptic. At that instant
 * the Moon *is* on the ecliptic, so its ecliptic longitude is the node's longitude.
 * Secant search with a tolerance well under one arcminute.
 */
export function trueNodeLongitude(date: Date): number {
  const target = date.getTime();
  const WINDOW_DAYS = 40; // a node crossing happens twice a month
  const STEP_MS = 6 * 3_600_000;

  const lat = (offsetMs: number) => {
    const vector = GeoVector(Body.Moon, new Date(target + offsetMs), true);
    return Ecliptic(vector).elat;
  };

  let previous = -WINDOW_DAYS * 86_400_000;
  let previousLat = lat(previous);
  for (let offset = previous + STEP_MS; offset <= WINDOW_DAYS * 86_400_000; offset += STEP_MS) {
    const currentLat = lat(offset);
    if (previousLat === 0 || (previousLat < 0) !== (currentLat < 0)) {
      let lo = previous;
      let hi = offset;
      for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        const midLat = lat(mid);
        if (previousLat < 0) {
          if (midLat < 0) lo = mid; else hi = mid;
        } else {
          if (midLat > 0) lo = mid; else hi = mid;
        }
      }
      return normalize(longitudeOf("Moon", new Date(target + (lo + hi) / 2)));
    }
    previous = offset;
    previousLat = currentLat;
  }
  throw new Error("Could not locate a lunar node crossing near the requested date");
}

export function trueNodeLongitudeWithFallback(date: Date): { longitude: number; method: "secant" | "event" } {
  try {
    return { longitude: trueNodeLongitude(date), method: "secant" };
  } catch {
    // The event API returns the crossing itself; the Moon's longitude at that moment is
    // the node. Same answer, different route — used only if the secant search fails.
    let event = SearchMoonNode(MakeTime(date));
    for (let i = 0; i < 6; i++) {
      if (event.kind === 1) break;
      const next = SearchMoonNode(MakeTime(new Date(event.time.date.getTime() + 86_400_000)));
      if (!next) break;
      event = next;
    }
    return { longitude: normalize(longitudeOf("Moon", event.time.date)), method: "event" };
  }
}
