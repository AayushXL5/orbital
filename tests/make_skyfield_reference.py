"""Write tests/fixtures/skyfield_reference.json: ISS passes computed with Skyfield
(rise/culminate/set, and sunlit + dark-sky visibility with the DE421 ephemeris).

    pip install skyfield && python tests/make_skyfield_reference.py

Needs network once to download de421.bsp (~17 MB) into .cache/skyfield/.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from skyfield.api import EarthSatellite, Loader, wgs84

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
SITES = {"pune": (18.5204, 73.8567), "london": (51.5074, -0.1278), "sydney": (-33.8688, 151.2093)}


def main():
    load = Loader(ROOT / ".cache" / "skyfield")
    ts = load.timescale()
    eph = load("de421.bsp")
    rec = next(r for r in json.loads((FIX / "gp_stations.json").read_text(encoding="utf-8"))
               if r["NORAD_CAT_ID"] == 25544)
    sat = EarthSatellite.from_omm(ts, rec)
    epoch = sat.epoch.utc_datetime().timestamp()
    out = {"norad": 25544, "t_start": epoch, "t_end": epoch + 3 * 86400, "sites": {}}
    for name, (lat, lon) in SITES.items():
        site = wgs84.latlon(lat, lon)
        t0 = ts.from_datetime(datetime.fromtimestamp(epoch, timezone.utc))
        t1 = ts.from_datetime(datetime.fromtimestamp(epoch + 3 * 86400, timezone.utc))
        times, events = sat.find_events(site, t0, t1, altitude_degrees=10.0)
        passes, cur = [], {}
        for ti, ev in zip(times, events):
            u = ti.utc_datetime().timestamp()
            if ev == 0:
                cur = {"start": u}
            elif ev == 1 and "start" in cur:
                cur["peak"] = u
                cur["max_el"] = float((sat - site).at(ti).altaz()[0].degrees)
            elif ev == 2 and "peak" in cur:
                cur["end"] = u
                samples = ts.from_datetimes([datetime.fromtimestamp(x, timezone.utc)
                                             for x in np.arange(cur["start"], cur["end"], 5.0)])
                lit = sat.at(samples).is_sunlit(eph)
                sun_alt = (eph["earth"] + site).at(samples).observe(eph["sun"]).apparent().altaz()[0].degrees
                cur["visible"] = bool(np.any(lit & (sun_alt < -6)))
                passes.append(cur)
                cur = {}
        out["sites"][name] = {"lat": lat, "lon": lon, "passes": passes}
    (FIX / "skyfield_reference.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    print({k: len(v["passes"]) for k, v in out["sites"].items()})


if __name__ == "__main__":
    main()
