import {
  BODIES, SIGN_NAMES, type BodyName, normalize, signOf, longitudeOf, isRetrograde,
  trueNodeLongitudeWithFallback, DEG,
} from "@/lib/astro";

/**
 * Chart v2 — the deterministic layer the reading is grounded in.
 *
 * Everything here is pure and time-explicit: `at` is always a parameter, never `Date.now()`.
 * That is what makes fixtures reproducible (see #102) and what stops a test from passing
 * today and failing next month.
 */

/**
 * Both systems are implemented and pinned against Swiss Ephemeris (#102,
 * `tests/ephemeris.test.ts`): whole-sign cusps exactly as the reference draws them,
 * Placidus cusps within 0.05° on every non-polar fixture. Which system a reading uses is
 * an entitlement decision (#107, decision 2: paid means not computed) — the engine
 * computes either on request and defaults to whole-sign. The 66° Ascendant cutoff is
 * product policy and applies to both — the reference still returns an Ascendant there —
 * regression-tested at its boundary from both hemispheres; and a cusp that would turn
 * circumpolar is refused exactly where Swiss Ephemeris refuses it, never approximated.
 */
export type HouseSystem = "whole-sign" | "placidus";

export const SUPPORTED_HOUSE_SYSTEMS: HouseSystem[] = ["whole-sign", "placidus"];

export type Placement = {
  sign: string;
  longitude: number;
  degree: number;
};

export type BodyPlacement = Placement & {
  body: BodyName;
  house: number | null;
  retrograde: boolean | null; // null = stationary on this date, do not claim a direction
};

export type AnglePlacement = Placement & { point: "Ascendant" | "Midheaven" };

export type AspectType = "conjunction" | "opposition" | "trine" | "square" | "sextile";

export type Aspect = {
  a: string;
  b: string;
  type: AspectType;
  angle: number;     // the exact angle between them, 0-180
  orb: number;       // |angle - exact|, always >= 0
  applying: boolean | null; // null when it cannot be determined from a single instant
  cross: boolean;    // true when it links the return chart to the natal chart
};

export type Balance = {
  fire: number; earth: number; air: number; water: number;
  cardinal: number; fixed: number; mutable: number;
};

export type ChartFacts = {
  chartVersion: "chart/2";
  at: string;                 // ISO instant the chart is cast for
  houseSystem: HouseSystem;
  /** True since the Placidus cusps pass the Swiss Ephemeris fixtures (tests/ephemeris.test.ts, 0.05°). */
  placidusValidated: true;
  notice: string | null;
  bodies: BodyPlacement[];
  angles: { ascendant: AnglePlacement | null; midheaven: AnglePlacement };
  nodes: { trueNode: BodyPlacement; southNode: BodyPlacement };
  houses: number[];           // cusp longitudes, index 0 = house 1
  aspects: Aspect[];          // return-chart internal
  crossAspects: Aspect[];     // return chart vs natal
  natal: {
    bodies: BodyPlacement[];
    angles: { ascendant: AnglePlacement | null; midheaven: AnglePlacement | null };
    houses: number[];
  };
  balance: Balance;
  warnings: string[];
};

// ------------------------------------------------------------------ houses

export function wholeSignCusps(ascendantLongitude: number): number[] {
  const start = Math.floor(normalize(ascendantLongitude) / 30) * 30;
  return Array.from({ length: 12 }, (_, index) => normalize(start + index * 30));
}

export function houseOf(longitude: number, cusps: number[]): number {
  for (let i = 0; i < 12; i++) {
    const start = cusps[i];
    const end = cusps[(i + 1) % 12];
    const span = normalize(end - start);
    const offset = normalize(longitude - start);
    if (offset < span || span === 0) return i + 1;
  }
  return 1;
}

/**
 * Placidus house cusps 1–12. The system's definition is the trisection of each cusp
 * point's own semi-arc, which is what makes it iterative: the point's declination sets
 * its semi-arc, the semi-arc sets the right ascension the cusp must sit at, and that
 * right ascension maps back to a new ecliptic longitude. Cusps 11 and 12 trisect the
 * diurnal semi-arc between the Midheaven and the Ascendant; cusps 2 and 3 the nocturnal
 * semi-arc between the Ascendant and the IC. The other eight are fixed by construction:
 * 1 = the Ascendant, 10 = the Midheaven, 4 and 7 their opposites, and each of 5, 6, 8, 9
 * opposes 11, 12, 2, 3 — in Placidus, opposite cusps are exactly 180° apart.
 *
 * An ecliptic point can only turn circumpolar above 90° − obliquity ≈ 66.56°, so below
 * the 66° product cutoff every semi-arc exists and the iteration contracts; the guard is
 * kept regardless and throws the way Swiss Ephemeris raises — a wrong cusp would
 * silently change what every reading built on it says.
 */
export function placidusCusps(
  ascendantLongitude: number,
  midheavenLongitude: number,
  ramcDegrees: number,
  latitude: number,
  obliquityDegrees: number,
): number[] {
  const theta = normalize(ramcDegrees);
  const eps = obliquityDegrees * DEG;
  const tanPhi = Math.tan(latitude * DEG);

  // Right ascension and declination of the ecliptic point at `longitude`, and the
  // inverse map (tan α = cos ε · tan λ, same quadrant).
  const raOf = (longitude: number) =>
    normalize(Math.atan2(Math.sin(longitude * DEG) * Math.cos(eps), Math.cos(longitude * DEG)) / DEG);
  const declinationOf = (longitude: number) =>
    Math.asin(Math.sin(eps) * Math.sin(longitude * DEG)) / DEG;
  const longitudeAtRa = (ra: number) =>
    normalize(Math.atan2(Math.sin(ra * DEG), Math.cos(ra * DEG) * Math.cos(eps)) / DEG);

  // One cusp: `fraction` of the point's own semi-arc — diurnal for 11 and 12
  // (α = θ + f·SDA; the Ascendant itself is the f = 1 case), nocturnal for 2 and 3
  // (α = θ + SDA + f·SNA; the IC is the f = 1 case).
  const cusp = (fraction: number, nocturnal: boolean, guessOffset: number): number => {
    let longitude = longitudeAtRa(theta + guessOffset);
    for (let step = 0; step < 100; step++) {
      const declination = declinationOf(longitude);
      if (Math.abs(tanPhi * Math.tan(declination * DEG)) >= 1) {
        throw new Error(
          `Placidus cusps are not computable at latitude ${latitude}°: the iterated point is ` +
          "circumpolar and its semi-arc does not exist — Swiss Ephemeris refuses here too. " +
          "Refusing rather than approximating.",
        );
      }
      const semiDiurnalArc = Math.acos(-tanPhi * Math.tan(declination * DEG)) / DEG;
      const ra = nocturnal
        ? theta + semiDiurnalArc + fraction * (180 - semiDiurnalArc)
        : theta + fraction * semiDiurnalArc;
      const next = longitudeAtRa(ra);
      const drift = normalize(next - longitude);
      if (Math.min(drift, 360 - drift) < 1e-9) return next;
      longitude = next;
    }
    throw new Error(
      `Placidus iteration did not converge at latitude ${latitude}° — refusing rather than approximating.`,
    );
  };

  // Round the four computed cusps and the two fixed angles to the 4 decimals every
  // recorded longitude carries, then derive the opposites from the rounded values — so
  // cusp 1 is *exactly* the recorded Ascendant and opposite cusps are *exactly* 180°
  // apart. A house boundary is the one place a rounding hair can flip a house: the
  // rounded Ascendant landing a decimal below its own unrounded cusp would read as
  // house 12.
  const round = (value: number) => Number(normalize(value).toFixed(4));
  const ascendant = round(ascendantLongitude);
  const midheaven = round(midheavenLongitude);
  const c11 = round(cusp(1 / 3, false, 30));
  const c12 = round(cusp(2 / 3, false, 60));
  const c2 = round(cusp(1 / 3, true, 120));
  const c3 = round(cusp(2 / 3, true, 150));

  return [
    ascendant,                       // 1
    c2,                              // 2
    c3,                              // 3
    normalize(midheaven + 180),      // 4 — the IC
    normalize(c11 + 180),            // 5
    normalize(c12 + 180),            // 6
    normalize(ascendant + 180),      // 7 — the descendant
    normalize(c2 + 180),             // 8
    normalize(c3 + 180),             // 9
    midheaven,                       // 10
    c11,                             // 11
    c12,                             // 12
  ];
}

// ------------------------------------------------------------------ angles

export function obliquity(date: Date): number {
  const centuries = (date.getTime() / 86_400_000 + 2440587.5 - 2451545) / 36525;
  return 23.43929111 - 0.013004167 * centuries - 0.0000001639 * centuries * centuries;
}

export function midheavenLongitude(ramcDegrees: number, obliquityDegrees: number): number {
  return normalize(Math.atan2(Math.sin(ramcDegrees * DEG), Math.cos(ramcDegrees * DEG) * Math.cos(obliquityDegrees * DEG)) / DEG);
}

// ------------------------------------------------------------------ aspects

const BASE_ORBS: Record<AspectType, number> = {
  conjunction: 8, opposition: 8, trine: 7, square: 7, sextile: 5,
};
const EXACT_ANGLES: Record<AspectType, number> = {
  conjunction: 0, opposition: 180, trine: 120, square: 90, sextile: 60,
};
const LUMINARIES = new Set(["Sun", "Moon"]);

/** Luminaries get a wider orb, as in common practice. */
export function orbFor(type: AspectType, a: string, b: string): number {
  const bonus = LUMINARIES.has(a) && LUMINARIES.has(b) ? 2 : LUMINARIES.has(a) || LUMINARIES.has(b) ? 1 : 0;
  return BASE_ORBS[type] + bonus;
}

function angularSeparation(a: number, b: number): number {
  const diff = Math.abs(normalize(a) - normalize(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function findAspects(
  points: { name: string; longitude: number }[],
  options: { cross?: boolean; tightOrb?: boolean } = {},
): Aspect[] {
  const out: Aspect[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      const separation = angularSeparation(a.longitude, b.longitude);
      for (const type of Object.keys(EXACT_ANGLES) as AspectType[]) {
        const exact = EXACT_ANGLES[type];
        const orb = Math.abs(separation - exact);
        const allowed = options.tightOrb ? Math.min(3, orbFor(type, a.name, b.name)) : orbFor(type, a.name, b.name);
        if (orb <= allowed) {
          out.push({
            a: a.name, b: b.name, type,
            angle: Number(separation.toFixed(4)),
            orb: Number(orb.toFixed(4)),
            applying: null, // needs two instants; filled by the caller when it matters
            cross: options.cross === true,
          });
        }
      }
    }
  }
  return out.sort((x, y) => x.orb - y.orb);
}

/**
 * Cross-aspects: every return point against every natal point, pairwise (#117).
 *
 * The first implementation flattened the two charts into synthetic points at
 * `return − natal` and ran `findAspects` over *those* — asking whether two differences
 * are in aspect to each other, which reported 2457 aspects on the baseline where 40
 * pairs actually apply. This asks the real question: is this return point separated from
 * that natal point by an exact aspect angle, within the configured per-body orbs (the
 * luminary bonus is applied to the bare body names on either side of the pair)? A pair
 * is reported at most once, at its tightest aspect.
 */
export function findCrossAspects(
  returnPoints: { name: string; longitude: number }[],
  natalPoints: { name: string; longitude: number }[],
): Aspect[] {
  const out: Aspect[] = [];
  for (const p of returnPoints) {
    for (const n of natalPoints) {
      const separation = angularSeparation(p.longitude, n.longitude);
      let best: { type: AspectType; orb: number } | null = null;
      for (const type of Object.keys(EXACT_ANGLES) as AspectType[]) {
        const orb = Math.abs(separation - EXACT_ANGLES[type]);
        if (orb <= orbFor(type, p.name, n.name) && (best === null || orb < best.orb)) {
          best = { type, orb };
        }
      }
      if (best) {
        out.push({
          a: p.name, b: `natal-${n.name}`, type: best.type,
          angle: Number(separation.toFixed(4)),
          orb: Number(best.orb.toFixed(4)),
          applying: null, // needs two instants; filled by the caller when it matters
          cross: true,
        });
      }
    }
  }
  return out.sort((x, y) => x.orb - y.orb);
}

// ------------------------------------------------------------------ chart

export type CastOptions = {
  /** Instant the chart is cast for. */
  at: Date;
  /** Place the houses and angles belong to. */
  latitude: number;
  longitude: number;
  /** Sidereal time at the instant, in degrees, already corrected for longitude. */
  ramcDegrees: number;
  houseSystem?: HouseSystem;
  /** Natal positions, if a cross-chart is wanted. */
  natal?: { bodies: { name: string; longitude: number }[]; at: Date };
};

function placementOf(body: BodyName, longitude: number, cusps: number[] | null, at: Date): BodyPlacement {
  const sign = signOf(longitude);
  return {
    body,
    sign: sign.sign,
    longitude: Number(normalize(longitude).toFixed(4)),
    degree: Number(sign.degree.toFixed(4)),
    house: cusps ? houseOf(longitude, cusps) : null,
    retrograde: isRetrograde(body, at),
  };
}

/**
 * Element and modality counts for a set of longitudes — the ten bodies plus the Ascendant
 * when it exists (the same population the element half has always counted; nodes and the
 * Midheaven are deliberately excluded). Modality cycles by sign: Aries cardinal, Taurus
 * fixed, Gemini mutable, then repeat.
 */
export function elementAndModality(longitudes: number[]): Balance {
  const balance: Balance = { fire: 0, earth: 0, air: 0, water: 0, cardinal: 0, fixed: 0, mutable: 0 };
  const elementOf = (signIndex: number) => (["fire", "earth", "air", "water"] as const)[signIndex % 4];
  const modalityOf = (signIndex: number) => (["cardinal", "fixed", "mutable"] as const)[signIndex % 3];
  for (const longitude of longitudes) {
    const { index } = signOf(longitude);
    balance[elementOf(index)] += 1;
    balance[modalityOf(index)] += 1;
  }
  return balance;
}

export function castChart(options: CastOptions): ChartFacts {
  const { at, latitude, longitude, ramcDegrees } = options;
  const houseSystem: HouseSystem = options.houseSystem ?? "whole-sign";
  const warnings: string[] = [];

  const eps = obliquity(at);
  const mcLongitude = midheavenLongitude(ramcDegrees, eps);

  let cusps: number[] | null = null;
  let notice: string | null = null;
  let ascendantLongitude: number | null = null;

  if (Math.abs(latitude) < 66) {
    const theta = normalize(ramcDegrees) * DEG;
    const phi = latitude * DEG;
    ascendantLongitude = normalize(
      Math.atan2(
        Math.cos(theta),
        -(Math.sin(theta) * Math.cos(eps * DEG) + Math.tan(phi) * Math.sin(eps * DEG)),
      ) / DEG,
    );

    cusps = houseSystem === "placidus"
      ? placidusCusps(ascendantLongitude, mcLongitude, ramcDegrees, latitude, eps)
      : wholeSignCusps(ascendantLongitude);
  } else {
    warnings.push("The Ascendant and houses are omitted at high latitudes.");
  }

  const bodies = BODIES.map(body => placementOf(body, longitudeOf(body, at), cusps, at));

  const node = trueNodeLongitudeWithFallback(at);
  const trueNode = placementOf("Moon", node.longitude, cusps, at);
  trueNode.body = "Moon"; // the node is a point, not a body; named in `nodes`
  const nodes = {
    trueNode: { ...trueNode, body: "Moon" as BodyName, sign: signOf(node.longitude).sign },
    southNode: {
      ...placementOf("Moon", normalize(node.longitude + 180), cusps, at),
      sign: signOf(normalize(node.longitude + 180)).sign,
    },
  };

  const angles = {
    ascendant: ascendantLongitude === null ? null : {
      point: "Ascendant" as const, ...signOf(ascendantLongitude),
      longitude: Number(ascendantLongitude.toFixed(4)),
      degree: Number(signOf(ascendantLongitude).degree.toFixed(4)),
    },
    midheaven: {
      point: "Midheaven" as const, ...signOf(mcLongitude),
      longitude: Number(mcLongitude.toFixed(4)),
      degree: Number(signOf(mcLongitude).degree.toFixed(4)),
    },
  };

  const points = [
    ...bodies.map(b => ({ name: b.body as string, longitude: b.longitude })),
    ...(ascendantLongitude === null ? [] : [{ name: "Ascendant", longitude: ascendantLongitude }]),
    { name: "Midheaven", longitude: mcLongitude },
    { name: "TrueNode", longitude: nodes.trueNode.longitude },
  ];

  const aspects = findAspects(points);
  // Pairwise return-vs-natal (#117): each return point against each natal body, at most
  // one aspect per pair under the configured per-body orbs.
  const crossAspects = options.natal ? findCrossAspects(points, options.natal.bodies) : [];

  const balance = elementAndModality([
    ...bodies.map(body => body.longitude),
    ...(ascendantLongitude === null ? [] : [ascendantLongitude]),
  ]);

  return {
    chartVersion: "chart/2",
    at: at.toISOString(),
    houseSystem,
    placidusValidated: true,
    notice,
    bodies,
    angles,
    nodes,
    houses: cusps ?? [],
    aspects,
    crossAspects,
    natal: options.natal
      ? {
          bodies: BODIES.map(b => placementOf(b, longitudeOf(b, options.natal!.at), null, options.natal!.at)),
          angles: { ascendant: null, midheaven: null },
          houses: [],
        }
      : { bodies: [], angles: { ascendant: null, midheaven: null }, houses: [] },
    balance,
    warnings,
  };
}

// ------------------------------------------------------------------ digest

/**
 * The PII-free payload sent to a language model (`docs/plan-readings-engine-epic.md` §5).
 *
 * Asserted by test: no name, email, birth date or birthplace can appear here — only derived
 * astrological facts. Keep it small: tight orbs only, and no redundant fields.
 */
export type ChartDigest = {
  chartVersion: "chart/2";
  houseSystem: HouseSystem;
  sun: { sign: string; degree: number; house: number | null };
  moon: { sign: string; degree: number; house: number | null };
  ascendant: string | null;
  midheaven: string;
  bodies: { body: string; sign: string; degree: number; house: number | null; retrograde: boolean | null }[];
  nodes: { north: string; south: string };
  aspects: { a: string; b: string; type: AspectType; orb: number }[];
  crossAspects: { a: string; b: string; type: AspectType; orb: number }[];
  balance: Balance;
  warnings: string[];
};

export function chartDigest(facts: ChartFacts): ChartDigest {
  const round = (value: number) => Number(value.toFixed(1));
  const strip = (a: Aspect) => ({
    a: a.a.split("/")[0],
    b: a.cross ? a.b.split("natal-")[1] ?? a.b : a.b,
    type: a.type,
    orb: round(a.orb),
  });
  return {
    chartVersion: "chart/2",
    houseSystem: facts.houseSystem,
    sun: pick(facts, "Sun"),
    moon: pick(facts, "Moon"),
    ascendant: facts.angles.ascendant?.sign ?? null,
    midheaven: facts.angles.midheaven.sign,
    bodies: facts.bodies.map(b => ({
      body: b.body, sign: b.sign, degree: round(b.degree), house: b.house, retrograde: b.retrograde,
    })),
    nodes: { north: facts.nodes.trueNode.sign, south: facts.nodes.southNode.sign },
    aspects: facts.aspects.map(strip),
    crossAspects: facts.crossAspects.slice(0, 24).map(strip),
    balance: facts.balance,
    warnings: facts.warnings,
  };
}

function pick(facts: ChartFacts, body: BodyName) {
  const found = facts.bodies.find(b => b.body === body);
  return {
    sign: found?.sign ?? SIGN_NAMES[0],
    degree: Number((found?.degree ?? 0).toFixed(1)),
    house: found?.house ?? null,
  };
}
