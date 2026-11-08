import { Body, Ecliptic, GeoVector, MakeTime, SunPosition } from "astronomy-engine";

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
 * Apparent geocentric ecliptic longitude of date, in degrees.
 *
 * **`EclipticLongitude` must not be used for chart positions.** Despite the name it returns
 * *heliocentric* longitude — the docs say so ("Calculates heliocentric ecliptic longitude")
 * and it throws for the Sun because the Sun has no heliocentric longitude. Measured against
 * Swiss Ephemeris (Moshier) for 2026-05-16T11:46:50Z it is wrong by up to 175° for the Moon,
 * 47° for Venus and 19° for Mars. Astrology needs geocentric positions, so every body goes
 * through `GeoVector(body, time, true)` — apparent, aberration-corrected, geocentric — and
 * then `Ecliptic()` to convert to the ecliptic of date.
 *
 * The Sun has its own function (`SunPosition().elon`), which agrees with Swiss Ephemeris to
 * 0.0001°; it is used for consistency with the existing v1 code path.
 */
export function longitudeOf(body: BodyName, date: Date): number {
  const time = MakeTime(date);
  if (body === "Sun") return normalize(SunPosition(time).elon);
  return normalize(Ecliptic(GeoVector(Body[body], time, true)).elon);
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
 * True (osculating) lunar node — the intersection of the Moon's *instantaneous* orbital
 * plane with the ecliptic, at the requested instant.
 *
 * Not "the Moon's longitude at the nearest crossing": that is a different quantity and was
 * measured 2.7° wrong against Swiss Ephemeris. This computes the orbital plane from two
 * positions either side of the date (h = r1 x r2), then takes the ascending node as
 * ẑ x h. Verified against Swiss Ephemeris TRUE_NODE: 335.3900° vs 335.3929° (0.003°, well
 * inside the 0.05° tolerance the fixture test enforces).
 */
export function trueNodeLongitude(date: Date, halfSpanHours = 3): number {
  const positionAt = (offsetHours: number) =>
    Ecliptic(GeoVector(Body.Moon, MakeTime(new Date(date.getTime() + offsetHours * 3_600_000)), true)).vec;

  const before = positionAt(-halfSpanHours);
  const after = positionAt(halfSpanHours);
  const h = {
    x: before.y * after.z - before.z * after.y,
    y: before.z * after.x - before.x * after.z,
    z: before.x * after.y - before.y * after.x,
  };
  if (Math.hypot(h.x, h.y) < 1e-12) throw new Error("Degenerate lunar orbital plane near the requested date");
  return normalize(Math.atan2(h.x, -h.y) * 180 / Math.PI);
}

/**
 * The node with a wider differentiation span as a fallback. There is deliberately no
 * "crossing-based" fallback: that approach is what produced the 2.7° error, so a failure
 * here must be a failure, not a quietly different number.
 */
export function trueNodeLongitudeWithFallback(date: Date): { longitude: number; method: "osculating" | "wide" } {
  try {
    return { longitude: trueNodeLongitude(date, 3), method: "osculating" };
  } catch {
    return { longitude: trueNodeLongitude(date, 12), method: "wide" };
  }
}
