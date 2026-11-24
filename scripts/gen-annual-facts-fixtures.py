"""Independent annual-facts reference. Dev-only pyswisseph==2.10.3.2; no app dependency.

Uses Python zoneinfo fold selection, Swiss Ephemeris Moshier geocentric positions,
whole-sign natal angles, and independently searched solar returns. Never imports
Solara code. The source/table/phase policy and numeric tolerances are recorded in
this fixture. Review diffs before accepting regenerated evidence.
"""
import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import swisseph as swe

ROOT = Path(__file__).resolve().parent.parent
FLAGS = swe.FLG_MOSEPH | swe.FLG_SPEED
BODIES = {"Sun": swe.SUN, "Moon": swe.MOON, "Mercury": swe.MERCURY, "Venus": swe.VENUS, "Mars": swe.MARS, "Jupiter": swe.JUPITER, "Saturn": swe.SATURN, "Uranus": swe.URANUS, "Neptune": swe.NEPTUNE, "Pluto": swe.PLUTO}
SLOW = ["Pluto", "Neptune", "Uranus", "Saturn", "Jupiter", "Mars", "Venus", "Mercury", "Sun", "Moon"]
SIGNS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"]
RULERS = ["Mars", "Venus", "Mercury", "Moon", "Sun", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Saturn", "Jupiter"]
ASPECTS = {"conjunction": (0, 3), "opposition": (180, 3), "trine": (120, 3), "square": (90, 3), "sextile": (60, 2)}
NY = {"name": "Synthetic New York", "latitude": 40.7128, "longitude": -74.006, "timezone": "America/New_York"}
CASES = [
    ("baseline", "1984-05-16", "01:00", {"name": "Synthetic Mexicali", "latitude": 32.6393, "longitude": -115.4747, "timezone": "America/Tijuana"}, 2026, "earlier"),
    ("fold-earlier", "2000-10-29", "01:30", NY, 2026, "earlier"),
    ("fold-later", "2000-10-29", "01:30", NY, 2026, "later"),
    ("southern", "1990-11-03", "22:15", {"name": "Synthetic Sydney", "latitude": -33.8688, "longitude": 151.2093, "timezone": "Australia/Sydney"}, 2026, "earlier"),
    ("leap-day", "1988-02-29", "12:00", {"name": "Synthetic Madrid", "latitude": 40.4168, "longitude": -3.7038, "timezone": "Europe/Madrid"}, 2027, "earlier"),
    ("polar-natal", "1975-06-21", "04:45", {"name": "Synthetic Tromso", "latitude": 69.65, "longitude": 18.96, "timezone": "Europe/Oslo"}, 2026, "earlier"),
]

def jd(dt):
    u = dt.astimezone(timezone.utc)
    return swe.julday(u.year, u.month, u.day, u.hour + u.minute/60 + u.second/3600 + u.microsecond/3.6e9)

def utc(value):
    return datetime.fromtimestamp((value - 2440587.5) * 86400, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def lon(body, instant):
    return swe.calc_ut(instant, BODIES[body], FLAGS)[0][0]

def distance(a, b):
    delta = (a - b) % 360
    return min(delta, 360 - delta)

def build(case):
    key, date, time, place, year, choice = case
    birth = datetime.fromisoformat(f"{date}T{time}").replace(tzinfo=ZoneInfo(place["timezone"]), fold=1 if choice == "later" else 0)
    birth_jd = jd(birth)
    # Search from seven days before the month start plus original day, including
    # leap day in a non-leap year without normalizing to a different age.
    anniversary = datetime(year, birth.month, 1, 12, tzinfo=timezone.utc) + timedelta(days=birth.day-1)
    reference = swe.solcross_ut(lon("Sun", birth_jd), jd(anniversary - timedelta(days=7)), swe.FLG_MOSEPH)
    assert distance(lon("Sun", reference), lon("Sun", birth_jd)) < 1e-6
    cusps, angles = swe.houses(birth_jd, place["latitude"], place["longitude"], b"W")
    asc = None if abs(place["latitude"]) >= 66 else angles[0]
    natal = {name: round(lon(name, birth_jd), 4) for name in BODIES}
    targets = {**natal, **({"Ascendant": round(asc, 4)} if asc is not None else {}), "Midheaven": round(angles[1], 4)}
    transits = []
    for body in SLOW:
        now, before, after = (lon(body, reference + offset) for offset in (0, -0.25, 0.25))
        speed = ((after - before + 180) % 360 - 180) * 2
        for target, fixed in targets.items():
            separation = distance(now, fixed)
            for kind, (exact, maximum) in ASPECTS.items():
                orb = abs(separation - exact)
                if orb > maximum:
                    continue
                derivative = abs(distance(after, fixed) - exact) - abs(distance(before, fixed) - exact)
                phase = "exact" if orb <= 0.001 else "stationary" if abs(speed) < 0.003 or abs(derivative) < 1e-7 else "applying" if derivative < 0 else "separating"
                transits.append({"transit": body, "natal": target, "type": kind, "orb": round(orb, 4), "phase": phase})
    order = list(targets)
    transits.sort(key=lambda a: (SLOW.index(a["transit"]), a["orb"], order.index(a["natal"])))
    age = year - birth.year
    profection = {"age": age, "house": None, "sign": None, "ruler": None}
    if asc is not None:
        index = (int(asc // 30) + age % 12) % 12
        profection.update(house=age % 12 + 1, sign=SIGNS[index], ruler=RULERS[index])
    return {"id": key, "input": {"name": "Synthetic Annual Facts", "birthDate": date, "birthTime": time, "birthPlace": place, "returnPlace": NY, "year": year, "timeChoice": choice},
            "birthUtc": birth.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), "referenceAt": utc(reference),
            "natalAscendant": round(asc, 4) if asc is not None else None, "natalMidheaven": round(angles[1], 4), "natalBodies": natal,
            "natalCusps": [round(v, 4) for v in cusps] if asc is not None else [], "profection": profection, "transits": transits}

payload = {"version": "annual-reference/1", "source": f"Swiss Ephemeris {swe.version}; pyswisseph Moshier, Python zoneinfo; developer reference, not editorial approval",
           "policy": "Selected-year age, traditional whole-sign natal profections; transits at solar-return instant, fixed natal points, 3/3/3/3/2 degree orbs; exact .001; stationary .003 degree/day; central +/-6h; slow-body/orb/natal order",
           "longitudeTolerance": 0.05, "returnTimeToleranceSeconds": 120, "cases": [build(case) for case in CASES]}
assert len(payload["cases"]) == 6
output = ROOT / "tests/fixtures/annual-facts.json"
fd, temp = tempfile.mkstemp(dir=output.parent, prefix=".annual-facts-")
try:
    with os.fdopen(fd, "w") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")
    os.replace(temp, output)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
print(f"Wrote {len(payload['cases'])} synthetic annual reference cases")
