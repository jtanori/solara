# 6. Solar return and house systems

## Current calculation

The engine uses Astronomy Engine's apparent geocentric positions for ten bodies.
It resolves the birth instant in the selected time zone and finds the Sun's return
to its natal longitude. The return location determines return angles and houses;
it does not change that instant. Deterministic chart saving defaults to **whole-sign**:
the Ascendant's sign is house 1, followed by the other signs in order.

Placidus is implemented as time-based quadrant cusps and compared against Swiss
Ephemeris reference fixtures in `tests/ephemeris.test.ts`. It is calculated for an
authorized paid job, not silently substituted into a free saved chart. At absolute
return latitude >=66°, or when the solver cannot produce all cusps, a paid job
stops **before any provider permit**. There is no fallback advertised as Placidus.
Whole-sign charts retain their explicit high-latitude angle/house limitation.

The separately frozen `paid-rich-v1` profile adds natal angles at the resolved
birth instant, traditional whole-sign annual profections and transits referenced
to the frozen return instant. Natal angles use the **birth** coordinates/zone,
not the return place. Missing natal Ascendant means unavailable profection, not a
substituted return Ascendant. Profection age is selected return year minus birth
year; traditional rulers are Mars for Scorpio, Saturn for Aquarius and Jupiter
for Pisces. These natal whole-sign houses remain distinct from Placidus return
houses. Exact orbs, ordering and motion rules are in the [paid runbook](10-paid-readings.md).
The transit section is not an annual calendar or a promise of future events.

## Local reference checks

```bash
npx tsx --test tests/solar.test.ts tests/chart.test.ts tests/ephemeris.test.ts tests/annual-facts.test.ts
```

Birth-time gaps are rejected; a fold requires the earlier/later occurrence. The
annual fixture includes both fold occurrences, a leap-day birth, southern
hemisphere and polar-natal limitation. It is independently generated with Python
zoneinfo and Swiss Moshier calculations, not Solara imports. Annual longitude
comparisons use 0.05° and return-time comparisons 120 seconds; those engineering
tolerances do not replace a professional acceptance threshold.

Reference refresh is optional dev-only work: `scripts/gen-ephemeris-fixtures.py`
and `scripts/gen-annual-facts-fixtures.py` require `pyswisseph==2.10.3.2`. Swiss is
**not a runtime/npm dependency**. Review its AGPL/commercial licensing before
redistributing it or using it in production. Preserve source/version/policy in
fixtures, examine numerical changes and rerun tests; never regenerate fixtures
to hide a calculation regression.

## Staging and production qualification

- Agree on zodiac/reference frame, precision, solver policy and professional
  acceptance tolerances before serving paying customers. Numerical regression
  evidence is not editorial sign-off or scientific validation of interpretations.
- Independently qualify historical zones and map-derived boundaries, especially
  pre-1970 transitions; current zone lookup cannot prove historical civil time.
- Paid editions preserve derived facts/display snapshot, content version and
  explicit calculation policy, so page/PDF do not recompute with today's engine.
  An exact historical runtime/TZ-data image is still a separate reproducibility
  and release concern; do not claim snapshots pin every external database.
- Keep generation off pending genuine provider/editorial evidence and the other
  release gates. No professional-accuracy claim, deterministic outcome or
  medical/financial guarantee is justified by passing these tests.

References: [Astronomy Engine](https://github.com/cosinekitty/astronomy),
[Swiss Ephemeris licensing](https://www.astro.com/swisseph/swephinfo_e.htm).
