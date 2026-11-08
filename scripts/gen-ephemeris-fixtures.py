import swisseph as swe, json
swe.set_ephe_path(None)  # Moshier analytic ephemeris; no data files, ~0.1 arcsec
BODIES = {"Sun":swe.SUN,"Moon":swe.MOON,"Mercury":swe.MERCURY,"Venus":swe.VENUS,"Mars":swe.MARS,
          "Jupiter":swe.JUPITER,"Saturn":swe.SATURN,"Uranus":swe.URANUS,"Neptune":swe.NEPTUNE,"Pluto":swe.PLUTO}

# Every case carries its return-place coordinates: the angles are a function of
# (instant, place), so the fixture must record both or the test cannot recompute them.
CASES = [
 ("baseline-2026","1984-05-16T01:00","America/Tijuana","2026-05-16T11:46:50.405Z","new-york",40.7128,-74.006,
  "The existing v1 fixture — regression anchor"),
 ("dst-fold-2000","2000-10-29T01:30","America/New_York","2000-10-29T05:30:00.000Z","new-york",40.7128,-74.006,
  "Ambiguous local time (DST fold); earlier offset chosen"),
 ("dst-gap-2000","2000-04-02T03:30","America/New_York","2000-04-02T07:30:00.000Z","new-york",40.7128,-74.006,
  "First valid instant after a spring-forward gap"),
 ("leap-day-2024","2024-02-29T12:00","Europe/Madrid","2024-02-29T11:00:00.000Z","madrid",40.4168,-3.7038,
  "Leap day birth"),
 ("southern-1990","1990-11-03T22:15","Australia/Sydney","1990-11-03T11:15:00.000Z","sydney",-33.8688,151.2093,
  "Southern hemisphere, AEDT"),
 ("high-lat-1975","1975-06-21T04:45","Europe/Oslo","1975-06-20T03:45:00.000Z","tromso",69.65,18.96,
  "Above the arctic circle in the return place"),
 ("pre-1970-1962","1962-03-08T19:30","America/Mexico_City","1962-03-09T01:30:00.000Z","mexico-city",19.4326,-99.1332,
  "Pre-1970 zone rules"),
]

# Product policy (src/lib/chart.ts, src/lib/solar.ts): no Ascendant and no houses at
# |latitude| >= 66. The true polar circle is 90° - obliquity ≈ 66.5°; the cutoff sits
# deliberately just below it.
POLAR_LIMIT = 66
TOLERANCE = 0.05

def jd_ut(iso):
    d = iso.replace("Z","")
    date, time = d.split("T")
    y,m,dd = [int(x) for x in date.split("-")]
    hh,mm,ss = time.split(":")
    return swe.julday(y,m,dd, int(hh)+int(mm)/60+float(ss)/3600)

out = []
for cid, birth, tz, when, place, lat, lon, note in CASES:
    jd = jd_ut(when)
    bodies = {}
    for name,pid in BODIES.items():
        pos,_ = swe.calc_ut(jd, pid, swe.FLG_SWIEPH | swe.FLG_SPEED)
        bodies[name] = {"longitude": round(pos[0],4), "speed": round(pos[3],4)}
    node = swe.calc_ut(jd, swe.TRUE_NODE)[0][0]

    # Angles and whole-sign cusps from the reference. ascmc = [ASC, MC, ARMC, ...];
    # for 'W' the cusps are the Ascendant's sign start + 30° increments.
    cusps, ascmc = swe.houses(jd, lat, lon, b"W")
    ascendant, midheaven, armc = ascmc[0], ascmc[1], ascmc[2]
    polar = abs(lat) >= POLAR_LIMIT
    try:
        swe.houses(jd, lat, lon, b"P")  # do the quadrant systems also refuse here?
        placidus_refused = False
    except swe.Error:
        placidus_refused = True

    case = {"id":cid,"note":note,"birth":birth,"timezone":tz,
            "castAt":when,"place":place,"latitude":lat,"longitude":lon,"polar":polar,
            "source":"Swiss Ephemeris 2.10.03 (pyswisseph), FLG_SWIEPH + Moshier fallback, geocentric apparent ecliptic of date",
            "bodies":bodies,"trueNode":round(node,4),
            "armc":round(armc,4),"midheaven":round(midheaven,4)}

    if polar:
        # Record the omission explicitly: a missing field could be a generation bug,
        # a null with a reason is a decision the tests can pin (#101).
        if placidus_refused:
            reason = (f"polar latitude |{lat}|° >= {POLAR_LIMIT}°: above the polar circle (90° - obliquity ≈ 66.5°) "
                      "the ecliptic's rising point is undefined for part of each sidereal day — the ascendant formula "
                      "returns the setting point, which Swiss Ephemeris flips by 180°, and its quadrant systems refuse "
                      "to compute here at all (swe.houses Placidus raises). No Ascendant or cusps are recorded; the "
                      "Midheaven is latitude-independent and remains valid.")
        else:
            reason = (f"polar latitude |{lat}|° >= {POLAR_LIMIT}°: the product cutoff sits just below the true polar "
                      "circle (90° - obliquity ≈ 66.5°), where the ascendant's daily sweep through the zodiac turns "
                      "retrograde and whole-sign houses stop being meaningful. No Ascendant or cusps are recorded; the "
                      "Midheaven is latitude-independent and remains valid.")
        case["ascendant"] = None
        case["ascendantOmittedReason"] = reason
        case["cusps"] = None
    else:
        # A cusp fixture is only meaningful when the Ascendant is not within tolerance of a
        # sign boundary — there a 0.05° error flips its sign and changes every cusp.
        edge = min(ascendant % 30, 30 - ascendant % 30)
        if edge < TOLERANCE:
            raise SystemExit(f"{cid}: Ascendant {ascendant:.4f}° is only {edge:.4f}° from a sign boundary — pick another instant")
        # Guard that the reference really drew whole-sign boundaries off the Ascendant.
        start = int(ascendant // 30) * 30
        expected = [(start + i * 30) % 360 for i in range(12)]
        if [round(c, 4) for c in cusps] != [float(e) for e in expected]:
            raise SystemExit(f"{cid}: Swiss Ephemeris 'W' cusps {cusps} are not the ASC sign boundaries {expected}")
        case["ascendant"] = round(ascendant,4)
        case["cusps"] = [round(c,4) for c in cusps]
    out.append(case)
print(json.dumps({"generated":"2026-11-08","ephemeris":"Swiss Ephemeris 2.10.03 (pyswisseph)",
                  "houses":"Swiss Ephemeris swe.houses(tjd_ut, lat, lon, 'W') — ASC/MC/ARMC from ascmc, whole-sign cusps; polar cases (|lat| >= 66°) record the Ascendant omission explicitly",
                  "toleranceDegrees":0.05,"cases":out}, indent=1))
