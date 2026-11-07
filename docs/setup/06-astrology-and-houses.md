# 6. Solar return and house systems

## Current calculation

The prototype uses Astronomy Engine for apparent geocentric Sun and Moon positions. It finds the instant the Sun reaches its natal longitude, applies the return location to the Ascendant, and uses **whole-sign houses**. In whole-sign houses, the sign containing the Ascendant is house 1 and each successive sign is a house. A return location at absolute latitude 66° or greater omits the Ascendant and houses pending verification.

**Placidus is not implemented.** It is a time-based quadrant house system whose cusps can be unequal and depend on location and time; some cusps can be unavailable at extreme latitudes. Different house systems can assign a planet to a different house, but they do not change the Sun's exact return instant. There is no environment variable or UI switch that enables Placidus today.

## Local setup

1. No external ephemeris key is needed for the current prototype. Run `npx tsx --test tests/solar.test.ts` for regression, DST gap/fold and high-latitude checks.
2. Enter an exact known birth time, birth coordinates/zone, return location and year. Verify the UTC instant and local time. The caller can choose the earlier or later occurrence of an ambiguous DST time; non-existent local times are rejected.
3. Treat these tests as regression tests, **not** independent professional validation. Historical time-zone databases and map-derived current zone boundaries may be inaccurate for a birth location/date.

## Staging setup

1. Before exposing results to customers, agree on zodiac/reference frame, ephemeris, house system, precision, high-latitude behavior and accepted tolerances with a qualified reviewer.
2. Compare a documented set of independent reference fixtures: leap days, birthdays near year boundaries, DST gaps/folds, historical zone changes, southern hemisphere and high latitudes. Record source, input, expected UTC instant/placements and tolerance.
3. If Placidus is required, evaluate a validated engine and licensing separately. Swiss Ephemeris is dual-licensed under AGPL and commercial terms; obtain legal review before use. Implement and compare cusp calculations and an explicit high-latitude fallback before exposing a selector.

## Production setup

1. Do not claim professional accuracy or sell a complete professional horoscope until the calculation, time zones, house system and content pass independent validation. Keep the reflective/entertainment disclaimer.
2. Version the calculation engine, inputs, time-zone data and content used for each report. Plan for reproducibility when dependencies or interpretations change; immutable report snapshots are not yet implemented.
3. Monitor error rates and protect personal birth data. Roll out any new house system behind a controlled release and verify it against approved fixtures in staging before production.

References: [Astronomy Engine](https://github.com/cosinekitty/astronomy), [Swiss Ephemeris licensing information](https://www.astro.com/swisseph/swephinfo_e.htm).
