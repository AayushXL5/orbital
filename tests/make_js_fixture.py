"""Write tests/fixtures/js_parity.json: passes computed by the Python code,
which tests/js/passes.test.mjs checks the browser code against.

    python tests/make_js_fixture.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from orbital.astro import ecef_to_geodetic  # noqa: E402
from orbital.flights import load_flights, model_and_track, resolve_t0  # noqa: E402
from orbital.passes import find_passes  # noqa: E402
from orbital.satellites import SgpObject  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
SITES = {"pune": (18.5204, 73.8567), "delhi": (28.6139, 77.2090), "sydney": (-33.8688, 151.2093)}


def main():
    iss = next(r for r in json.loads((FIX / "gp_stations.json").read_text(encoding="utf-8")) if r["NORAD_CAT_ID"] == 25544)
    sat = SgpObject(iss)
    t_start = sat.epoch_unix
    cases = []
    for name, (lat, lon) in SITES.items():
        passes = find_passes(sat.ecef, lat, lon, t_start, t_start + 3 * 86400)
        cases.append({"site": name, "lat": lat, "lon": lon, "t_start": t_start,
                      "t_end": t_start + 3 * 86400, "passes": [p.to_dict() for p in passes]})

    flight = next(f for f in load_flights(ROOT / "flights") if f["id"] == "starship-ift14")
    _, track = model_and_track(flight)
    t0, _ = resolve_t0(flight, None)
    lat, lon, alt = ecef_to_geodetic(track.xyz)
    flight_export = {"t0": flight["t0_actual"], "met_end": track.end_s,
                     "phases": {"insertion": flight["model"]["insertion_s"], "deorbit": flight["model"]["deorbit_s"]},
                     "track": {"met": track.met.tolist(), "lat": np.round(lat, 4).tolist(),
                               "lon": np.round(lon, 4).tolist(), "alt": np.round(alt, 2).tolist()}}
    flight_cases = []
    for name, (la, lo) in SITES.items():
        passes = find_passes(lambda t: track.ecef(t, t0), la, lo, t0, t0 + track.end_s)
        flight_cases.append({"site": name, "lat": la, "lon": lo, "passes": [p.to_dict() for p in passes]})

    out = {"iss": iss, "iss_cases": cases, "flight": flight_export, "flight_cases": flight_cases}
    (FIX / "js_parity.json").write_text(json.dumps(out), encoding="utf-8")
    print("iss passes:", [len(c["passes"]) for c in cases], "flight passes:", [len(c["passes"]) for c in flight_cases])


if __name__ == "__main__":
    main()
