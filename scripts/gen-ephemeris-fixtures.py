import swisseph as swe, json
swe.set_ephe_path(None)  # Moshier analytic ephemeris; no data files, ~0.1 arcsec
BODIES = {"Sun":swe.SUN,"Moon":swe.MOON,"Mercury":swe.MERCURY,"Venus":swe.VENUS,"Mars":swe.MARS,
          "Jupiter":swe.JUPITER,"Saturn":swe.SATURN,"Uranus":swe.URANUS,"Neptune":swe.NEPTUNE,"Pluto":swe.PLUTO}

CASES = [
 ("baseline-2026","1984-05-16T01:00","America/Tijuana","2026-05-16T11:46:50.405Z","new-york",
  "The existing v1 fixture — regression anchor"),
 ("dst-fold-2000","2000-10-29T01:30","America/New_York","2000-10-29T05:30:00.000Z","new-york",
  "Ambiguous local time (DST fold); earlier offset chosen"),
 ("dst-gap-2000","2000-04-02T03:30","America/New_York","2000-04-02T07:30:00.000Z","new-york",
  "First valid instant after a spring-forward gap"),
 ("leap-day-2024","2024-02-29T12:00","Europe/Madrid","2024-02-29T11:00:00.000Z","madrid",
  "Leap day birth"),
 ("southern-1990","1990-11-03T22:15","Australia/Sydney","1990-11-03T11:15:00.000Z","sydney",
  "Southern hemisphere, AEDT"),
 ("high-lat-1975","1975-06-21T04:45","Europe/Oslo","1975-06-20T03:45:00.000Z","tromso",
  "Above the arctic circle in the return place"),
 ("pre-1970-1962","1962-03-08T19:30","America/Mexico_City","1962-03-09T01:30:00.000Z","mexico-city",
  "Pre-1970 zone rules"),
]

def jd_ut(iso):
    d = iso.replace("Z","")
    date, time = d.split("T")
    y,m,dd = [int(x) for x in date.split("-")]
    hh,mm,ss = time.split(":")
    return swe.julday(y,m,dd, int(hh)+int(mm)/60+float(ss)/3600)

out = []
for cid, birth, tz, when, place, note in CASES:
    jd = jd_ut(when)
    bodies = {}
    for name,pid in BODIES.items():
        pos,_ = swe.calc_ut(jd, pid, swe.FLG_SWIEPH | swe.FLG_SPEED)
        bodies[name] = {"longitude": round(pos[0],4), "speed": round(pos[3],4)}
    node = swe.calc_ut(jd, swe.TRUE_NODE)[0][0]
    out.append({"id":cid,"note":note,"birth":birth,"timezone":tz,
                "castAt":when,"place":place,
                "source":"Swiss Ephemeris 2.10.03 (pyswisseph), FLG_SWIEPH + Moshier fallback, geocentric apparent ecliptic of date",
                "bodies":bodies,"trueNode":round(node,4)})
print(json.dumps({"generated":"2026-11-08","ephemeris":"Swiss Ephemeris 2.10.03 (pyswisseph)","toleranceDegrees":0.05,"cases":out}, indent=1))
