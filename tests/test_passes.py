import numpy as np
import pytest

from conftest import load
from orbital import astro
from orbital.passes import find_passes
from orbital.satellites import SgpObject


@pytest.fixture(scope="module")
def iss():
    return SgpObject(next(r for r in load("gp_stations.json") if r["NORAD_CAT_ID"] == 25544))


def test_passes_match_skyfield(iss):
    """Rise, peak and set within a second, and the same visible/not-visible call."""
    ref = load("skyfield_reference.json")
    for name, site in ref["sites"].items():
        mine = find_passes(iss.ecef, site["lat"], site["lon"], ref["t_start"], ref["t_end"], min_el=10.0)
        theirs = site["passes"]
        assert len(mine) == len(theirs), name
        for p, q in zip(mine, theirs):
            assert abs(p.start - q["start"]) < 1.0
            assert abs(p.peak - q["peak"]) < 1.0
            assert abs(p.end - q["end"]) < 1.0
            assert abs(p.max_el - q["max_el"]) < 0.05
            assert p.visible == q["visible"], f"{name} pass at {q['start']}"


def test_visible_part_lies_inside_the_pass(iss):
    t0 = iss.epoch_unix
    for p in find_passes(iss.ecef, 51.5074, -0.1278, t0, t0 + 3 * 86400):
        assert p.start < p.peak < p.end
        if p.visible:
            assert p.start <= p.vis_start <= p.vis_end <= p.end
            assert p.vis_max_el <= p.max_el + 1e-6


def test_undefined_positions_mean_no_pass():
    assert find_passes(lambda t: np.full((len(np.atleast_1d(t)), 3), np.nan), 0, 0, 0, 3600) == []


def test_sun_and_frames():
    # Northern summer solstice: the Sun sits near +23.44 deg declination.
    t = 1782000000.0  # 2026-06-21
    s = astro.sun_direction_inertial(t)
    assert abs(np.degrees(np.arcsin(s[2])) - 23.44) < 0.1
    lat, lon, h = astro.ecef_to_geodetic(astro.geodetic_to_ecef(18.52, 73.86, 275.0))
    assert abs(lat - 18.52) < 1e-9 and abs(lon - 73.86) < 1e-9 and abs(h - 275.0) < 1e-6
    assert astro.compass(0) == "N" and astro.compass(225) == "SW" and astro.compass(359) == "N"
