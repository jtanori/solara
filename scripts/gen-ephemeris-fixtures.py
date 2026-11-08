"""Regenerate tests/fixtures/ephemeris.json from Swiss Ephemeris (pyswisseph).

Reference: pyswisseph==2.10.3.2 (Swiss Ephemeris {swe.version}); install with
  python3 -m venv .venv && .venv/bin/pip install pyswisseph==2.10.3.2
The recorded provenance is derived from swe.version at run time — never a literal — so a
regeneration under a different library version cannot keep the old label.

Writes tests/fixtures/ephemeris.json atomically, and only after every self-check has
passed (shell redirection would truncate the committed fixture before validation runs).
Pass a path to write elsewhere, or --stdout to print.
"""
import json
import os
import swisseph as swe
import sys
import tempfile

swe.set_ephe_path(None)  # Moshier analytic ephemeris; no data files, ~0.1 arcsec

EPHEMERIS = f"Swiss Ephemeris {swe.version} (pyswisseph)"  # derived, not a literal

BODIES = {"Sun":swe.SUN,"Moon":swe.MOON,"Mercury":swe.MERCURY,"Venus":swe.VENUS,"Mars":swe.MARS,
          "Jupiter":swe.JUPITER,"Saturn":swe.SATURN,"Uranus":swe.URANUS,"Neptune":swe.NEPTUNE,"Pluto":swe.PLUTO}

# Every case carries both places: the angles are a function of (instant, return place), and
# the end-to-end test drives calculateSolarReturnChart from the birth data. `returnYear` is
# present exactly when castAt is a searched solar return (only the baseline is).
CASES = [
 {"id":"baseline-2026","birth":"1984-05-16T01:00","timezone":"America/Tijuana",
  "castAt":"2026-05-16T11:46:50.405Z","place":"new-york","latitude":40.7128,"longitude":-74.006,
  "returnTimezone":"America/New_York","birthLatitude":32.6393,"birthLongitude":-115.4747,"returnYear":2026,
  "note":"The existing v1 fixture — regression anchor"},
 {"id":"dst-fold-2000","birth":"2000-10-29T01:30","timezone":"America/New_York",
  "castAt":"2000-10-29T05:30:00.000Z","place":"new-york","latitude":40.7128,"longitude":-74.006,
  "returnTimezone":"America/New_York","birthLatitude":40.7128,"birthLongitude":-74.006,
  "note":"Ambiguous local time (DST fold); earlier offset chosen"},
 {"id":"dst-gap-2000","birth":"2000-04-02T03:30","timezone":"America/New_York",
  "castAt":"2000-04-02T07:30:00.000Z","place":"new-york","latitude":40.7128,"longitude":-74.006,
  "returnTimezone":"America/New_York","birthLatitude":40.7128,"birthLongitude":-74.006,
  "note":"First valid instant after a spring-forward gap"},
 {"id":"leap-day-2024","birth":"2024-02-29T12:00","timezone":"Europe/Madrid",
  "castAt":"2024-02-29T11:00:00.000Z","place":"madrid","latitude":40.4168,"longitude":-3.7038,
  "returnTimezone":"Europe/Madrid","birthLatitude":40.4168,"birthLongitude":-3.7038,
  "note":"Leap day birth"},
 {"id":"southern-1990","birth":"1990-11-03T22:15","timezone":"Australia/Sydney",
  "castAt":"1990-11-03T11:15:00.000Z","place":"sydney","latitude":-33.8688,"longitude":151.2093,
  "returnTimezone":"Australia/Sydney","birthLatitude":-33.8688,"birthLongitude":151.2093,
  "note":"Southern hemisphere, AEDT"},
 {"id":"high-lat-1975","birth":"1975-06-21T04:45","timezone":"Europe/Oslo",
  "castAt":"1975-06-20T03:45:00.000Z","place":"tromso","latitude":69.65,"longitude":18.96,
  "returnTimezone":"Europe/Oslo","birthLatitude":59.9139,"birthLongitude":10.7522,
  "note":"Above the arctic circle in the return place"},
 {"id":"pre-1970-1962","birth":"1962-03-08T19:30","timezone":"America/Mexico_City",
  "castAt":"1962-03-09T01:30:00.000Z","place":"mexico-city","latitude":19.4326,"longitude":-99.1332,
  "returnTimezone":"America/Mexico_City","birthLatitude":19.4326,"birthLongitude":-99.1332,
  "note":"Pre-1970 zone rules"},
]

# Product policy (src/lib/chart.ts, src/lib/solar.ts): no Ascendant and no houses at
# |latitude| >= 66. The true polar circle is 90° - obliquity ≈ 66.5°; the cutoff sits
# deliberately just below it.
POLAR_LIMIT = 66
TOLERANCE = 0.05

# Latitude probes pinning the cutoff itself: both hemispheres, exactly ±66° and just below.
# They share one instant and meridian with the polar case above, and carry angles only —
# body positions live in CASES and would be identical for all probes.
CUTOFF_PROBE_LATITUDES = [-69.65, -66.0, -65.9, 65.9, 66.0]
CUTOFF_PROBE_LONGITUDE = 18.96
CUTOFF_PROBE_CASTAT = "1975-06-20T03:45:00.000Z"

def jd_ut(iso):
    d = iso.replace("Z","")
    date, time = d.split("T")
    y,m,dd = [int(x) for x in date.split("-")]
    hh,mm,ss = time.split(":")
    return swe.julday(y,m,dd, int(hh)+int(mm)/60+float(ss)/3600)

def angles(jd, lat, lon):
    """(cusps, ascendant, midheaven, armc, placidus_refused) from the reference.

    'W' is whole-sign: the cusps are the Ascendant's sign start + 30° increments. The
    Placidus call is a probe, not the system we record — its outcome is stored as an
    observed fact and nothing stronger is claimed from it.
    """
    cusps, ascmc = swe.houses(jd, lat, lon, b"W")
    try:
        swe.houses(jd, lat, lon, b"P")
        placidus_refused = False
    except swe.Error:
        placidus_refused = True
    return cusps, ascmc[0], ascmc[1], ascmc[2], placidus_refused

def polar_reason(lat, ascendant, placidus_refused, polar_circle):
    """Why the fixture records ascendant: null — Solara policy, stated as such.

    The reference is quoted only for what was actually observed: the whole-sign value it
    still returns at this instant, and the outcome of the one Placidus call.
    """
    if placidus_refused:
        return (f"polar latitude |{lat}|° >= {POLAR_LIMIT}°, above the true polar circle "
                f"(90° - obliquity = {polar_circle:.2f}°): Solara omits the Ascendant and houses by policy, "
                f"pending independent validation. At this instant Swiss Ephemeris's whole-sign system still "
                f"returns {ascendant:.4f}° — above the polar circle that value is circumpolar-ambiguous: the "
                f"ascendant formula returns the setting point for part of each sidereal day, which Swiss "
                f"Ephemeris flips by 180°. swe.houses raises for Placidus at this instant and place. "
                f"The Midheaven is latitude-independent and remains valid.")
    return (f"latitude |{lat}|° is at or above Solara's {POLAR_LIMIT}° cutoff but below the true polar "
            f"circle (90° - obliquity = {polar_circle:.2f}°): the Ascendant is still computable — Swiss "
            f"Ephemeris whole-sign returns {ascendant:.4f}° here, and its Placidus call succeeds — but "
            f"the product omits the Ascendant and houses by policy; the cutoff deliberately sits below "
            f"the polar circle, where the ascendant's daily sweep through the zodiac turns retrograde. "
            f"The Midheaven is latitude-independent and remains valid.")

def build_case(case):
    jd = jd_ut(case["castAt"])
    bodies = {}
    for name,pid in BODIES.items():
        pos,_ = swe.calc_ut(jd, pid, swe.FLG_SWIEPH | swe.FLG_SPEED)
        bodies[name] = {"longitude": round(pos[0],4), "speed": round(pos[3],4)}
    node = swe.calc_ut(jd, swe.TRUE_NODE)[0][0]
    eps = swe.calc_ut(jd, swe.ECL_NUT)[0][0]
    polar_circle = 90 - eps

    cusps, ascendant, midheaven, armc, placidus_refused = angles(jd, case["latitude"], case["longitude"])
    polar = abs(case["latitude"]) >= POLAR_LIMIT

    out = {"id":case["id"],"note":case["note"],"birth":case["birth"],"timezone":case["timezone"],
           "castAt":case["castAt"],"place":case["place"],
           "latitude":case["latitude"],"longitude":case["longitude"],"returnTimezone":case["returnTimezone"],
           "birthLatitude":case["birthLatitude"],"birthLongitude":case["birthLongitude"],
           "polar":polar,
           "source":f"{EPHEMERIS}, FLG_SWIEPH + Moshier fallback, geocentric apparent ecliptic of date",
           "bodies":bodies,"trueNode":round(node,4),
           "armc":round(armc,4),"midheaven":round(midheaven,4)}
    if "returnYear" in case:
        out["returnYear"] = case["returnYear"]

    if polar:
        # Record the omission explicitly: a missing field could be a generation bug,
        # a null with a reason is a decision the tests can pin (#101).
        out["ascendant"] = None
        out["ascendantOmittedReason"] = polar_reason(case["latitude"], ascendant, placidus_refused, polar_circle)
        out["placidusRefused"] = placidus_refused
        out["cusps"] = None
    else:
        # A cusp fixture is only meaningful when the Ascendant is not within tolerance of a
        # sign boundary — there a 0.05° error flips its sign and changes every cusp.
        edge = min(ascendant % 30, 30 - ascendant % 30)
        if edge < TOLERANCE:
            raise SystemExit(f"{case['id']}: Ascendant {ascendant:.4f}° is only {edge:.4f}° from a sign boundary — pick another instant")
        # Guard that the reference really drew whole-sign boundaries off the Ascendant.
        start = int(ascendant // 30) * 30
        expected = [(start + i * 30) % 360 for i in range(12)]
        if [round(c, 4) for c in cusps] != [float(e) for e in expected]:
            raise SystemExit(f"{case['id']}: Swiss Ephemeris 'W' cusps {cusps} are not the ASC sign boundaries {expected}")
        out["ascendant"] = round(ascendant,4)
        out["cusps"] = [round(c,4) for c in cusps]
    return out

def build_cutoff_probes():
    jd = jd_ut(CUTOFF_PROBE_CASTAT)
    eps = swe.calc_ut(jd, swe.ECL_NUT)[0][0]
    polar_circle = 90 - eps
    probes = []
    for lat in CUTOFF_PROBE_LATITUDES:
        cusps, ascendant, midheaven, armc, placidus_refused = angles(jd, lat, CUTOFF_PROBE_LONGITUDE)
        polar = abs(lat) >= POLAR_LIMIT
        probe = {"latitude":lat,"polar":polar,"armc":round(armc,4),"midheaven":round(midheaven,4)}
        if polar:
            probe["ascendant"] = None
            probe["ascendantOmittedReason"] = polar_reason(lat, ascendant, placidus_refused, polar_circle)
            probe["placidusRefused"] = placidus_refused
            probe["cusps"] = None
        else:
            edge = min(ascendant % 30, 30 - ascendant % 30)
            if edge < TOLERANCE:
                raise SystemExit(f"cutoff probe at {lat}°: Ascendant {ascendant:.4f}° is only {edge:.4f}° from a sign boundary")
            probe["ascendant"] = round(ascendant,4)
            probe["cusps"] = [round(c,4) for c in cusps]
        probes.append(probe)
    return {"castAt":CUTOFF_PROBE_CASTAT,"longitude":CUTOFF_PROBE_LONGITUDE,
            "note":("Latitude probes pinning the |latitude| >= 66 cutoff: both hemispheres, exactly ±66° and "
                    "just below. One instant and meridian shared with high-lat-1975; angles only — body "
                    "positions are in cases and are identical across probes."),
            "probes":probes}

def main():
    payload = {"generated":"2026-11-08","ephemeris":EPHEMERIS,
               "houses":(f"{EPHEMERIS} swe.houses(tjd_ut, lat, lon, 'W') — ASC/MC/ARMC from ascmc, whole-sign "
                         "cusps; polar cases (|lat| >= 66°) record the Ascendant omission explicitly — Solara "
                         "policy, with the reference's whole-sign value and Placidus outcome quoted as observed"),
               "toleranceDegrees":TOLERANCE,
               "cutoffProbes":build_cutoff_probes(),
               "cases":[build_case(case) for case in CASES]}
    text = json.dumps(payload, indent=1) + "\n"

    if "--stdout" in sys.argv:
        sys.stdout.write(text)
        return
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    path = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                             os.pardir, "tests", "fixtures", "ephemeris.json")
    path = os.path.normpath(path)
    # All validation has already happened above; write through a temp file and replace, so
    # a failure anywhere can never leave a truncated or half-written fixture behind.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".ephemeris-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    print(f"wrote {path} ({len(text)} bytes)")

if __name__ == "__main__":
    main()
