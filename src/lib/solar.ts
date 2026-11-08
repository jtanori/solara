import { Body, Ecliptic, GeoVector, SearchSunLongitude, SiderealTime, SunPosition } from "astronomy-engine";
import { DateTime, IANAZone } from "luxon";
import type { ChartInput, ChartResult, Place, Placement } from "@/lib/types";
import { castChart, type ChartFacts } from "@/lib/chart";
import { longitudeOf, type BodyName } from "@/lib/astro";

export const SIGNS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"] as const;
const normalize = (value: number) => ((value % 360) + 360) % 360;

function placement(longitude: number): Placement {
  const value = normalize(longitude);
  return { sign: SIGNS[Math.floor(value / 30)], longitude: value, degree: value % 30 };
}

function validPlace(value: unknown): value is Place {
  if (!value || typeof value !== "object") return false;
  const p = value as Place;
  return typeof p.name === "string" && p.name.trim().length > 1 && p.name.length <= 160 &&
    typeof p.latitude === "number" && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
    typeof p.longitude === "number" && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180 &&
    typeof p.timezone === "string" && IANAZone.isValidZone(p.timezone);
}

export function calculateSolarReturn(input: ChartInput): ChartResult {
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 100 ||
      typeof input.birthDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate) ||
      typeof input.birthTime !== "string" || !/^\d{2}:\d{2}$/.test(input.birthTime) ||
      !validPlace(input.birthPlace) || !validPlace(input.returnPlace) ||
      !Number.isInteger(input.year) || input.year < 1900 || input.year > 2100) {
    throw new Error("Please check the birth details, locations, time zones, and year.");
  }
  const localString = `${input.birthDate}T${input.birthTime}`;
  let birth = DateTime.fromISO(localString, { zone: input.birthPlace.timezone });
  if (!birth.isValid || birth.toFormat("yyyy-MM-dd'T'HH:mm") !== localString) {
    throw new Error("That local birth time does not exist in the selected time zone. Please check for a daylight-saving clock change.");
  }
  if (birth.toMillis() > Date.now() || input.year < birth.year) throw new Error("Please choose a valid birth date and a return year after birth.");
  const warnings: string[] = [];
  const possibilities = birth.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis());
  if (possibilities.length > 1) {
    birth = input.timeChoice === "later" ? possibilities[possibilities.length - 1] : possibilities[0];
    warnings.push(`Your birth time occurs twice because of a clock change. The ${input.timeChoice === "later" ? "later" : "earlier"} occurrence was used.`);
  }
  const sunLongitude = SunPosition(birth.toJSDate()).elon;
  // The return can happen on the day before or after the calendar birthday.
  const anniversary = Date.UTC(input.year, birth.month - 1, birth.day, 12);
  const start = new Date(anniversary - 7 * 86400000);
  const event = SearchSunLongitude(sunLongitude, start, 14);
  if (!event) throw new Error("We could not find a solar return for that year. Please check the details.");
  const when = event.date;
  const moonLongitude = Ecliptic(GeoVector(Body.Moon, when, true)).elon;
  let ascendant: Placement | null = null;
  let sunHouse: number | null = null;
  if (Math.abs(input.returnPlace.latitude) < 66) {
    // Apparent sidereal time + east-positive longitude; mean obliquity approximation.
    const theta = normalize(SiderealTime(when) * 15 + input.returnPlace.longitude) * Math.PI / 180;
    const latitude = input.returnPlace.latitude * Math.PI / 180;
    const centuries = (when.getTime() / 86400000 + 2440587.5 - 2451545) / 36525;
    const epsilon = (23.43929111 - 0.013004167 * centuries) * Math.PI / 180;
    const asc = Math.atan2(Math.cos(theta), -(Math.sin(theta) * Math.cos(epsilon) + Math.tan(latitude) * Math.sin(epsilon))) * 180 / Math.PI;
    ascendant = placement(asc);
    sunHouse = ((Math.floor(normalize(sunLongitude) / 30) - Math.floor(ascendant.longitude / 30) + 12) % 12) + 1;
  } else {
    warnings.push("The Ascendant and houses are omitted at high latitudes until the calculation is independently verified.");
  }
  warnings.push("Prototype calculation: independently verify the result and historical time-zone rules before using it as a professional chart.");
  const local = DateTime.fromJSDate(when, { zone: input.returnPlace.timezone });
  return {
    exactUtc: when.toISOString(),
    localTime: local.toISO() ?? when.toISOString(),
    natalSun: placement(sunLongitude),
    moon: placement(moonLongitude),
    ascendant,
    sunHouse,
    houseSystem: "Whole sign",
    warnings,
    engine: "Astronomy Engine · apparent geocentric ecliptic of date",
  };
}

/**
 * Chart v2 — the solar-return chart plus the natal chart it activates.
 *
 * Additive: `calculateSolarReturn` keeps its contract, so saved readings and the existing
 * UI are untouched. Fills the gap identified in the readings audit: v1 knows three
 * positions (Sun, Moon, ASC); v2 knows ten bodies, their houses, both angles, the true
 * node, and the aspects within the return chart and between it and the natal chart.
 */
export function calculateSolarReturnChart(input: ChartInput): { result: ChartResult; facts: ChartFacts } {
  const result = calculateSolarReturn(input);

  // Natal chart, cast for the birth moment at the birth place.
  const birthLocal = DateTime.fromISO(`${input.birthDate}T${input.birthTime}`, { zone: input.birthPlace.timezone });
  const offsets = birthLocal.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis());
  const birth = input.timeChoice === "later" && offsets.length > 1 ? offsets[offsets.length - 1] : offsets[0];
  const natalAt = birth.toJSDate();

  const when = new Date(result.exactUtc);
  const ramc = normalize(SiderealTime(when as unknown as Parameters<typeof SiderealTime>[0]) * 15 + input.returnPlace.longitude);

  const facts = castChart({
    at: when,
    latitude: input.returnPlace.latitude,
    longitude: input.returnPlace.longitude,
    ramcDegrees: ramc,
    houseSystem: "whole-sign",
    natal: {
      at: natalAt,
      bodies: [
        "Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto",
      ].map(body => ({ name: body, longitude: longitudeOf(body as BodyName, natalAt) })),
    },
  });

  return { result, facts };
}
