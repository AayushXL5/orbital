import json

import numpy as np
import pytest

from conftest import ROOT, load
from orbital.astro import ecef_to_geodetic, geodetic_to_ecef
from orbital.flightmodel import FlightModel, FlightTrack


def separation_deg(lat1, lon1, lat2, lon2):
    a, b = geodetic_to_ecef(lat1, lon1), geodetic_to_ecef(lat2, lon2)
    a = a / np.linalg.norm(a, axis=-1, keepdims=True)
    b = b / np.linalg.norm(b, axis=-1, keepdims=True)
    return np.degrees(np.arccos(np.clip(np.sum(a * b, axis=-1), -1, 1)))


@pytest.fixture(scope="module")
def ift14():
    flight = json.loads((ROOT / "flights" / "starship-ift14.json").read_text(encoding="utf-8"))
    return flight, FlightModel.from_flight(flight)


def test_orbit_matches_exoplanet5_track(ift14):
    """The model follows exoplanet5's zone-fitted IFT-14 orbit to within ~0.2 deg."""
    _, model = ift14
    ref = load("ift14_reference_track.json")["nominal"]
    met = ref["met0"] + ref["dt"] * np.arange(len(ref["lat"]))
    orbit = met >= 1528
    lat, lon, _ = ecef_to_geodetic(model.ecef(met[orbit]))
    err = separation_deg(lat, lon, np.array(ref["lat"])[orbit], np.array(ref["lon"])[orbit])
    assert err.mean() < 0.25
    assert err.max() < 0.4


def test_descent_lands_on_target(ift14):
    flight, model = ift14
    lat, lon, alt = ecef_to_geodetic(model.ecef([flight["model"]["end_s"]]))
    target = flight["model"]["landing"]
    assert separation_deg(lat, lon, np.array([target["lat"]]), np.array([target["lon"]]))[0] < 0.05
    assert alt[0] < 1.0


def test_starts_on_the_pad_and_climbs(ift14):
    flight, model = ift14
    lat, lon, alt = ecef_to_geodetic(model.ecef([0.0, 491.0, 1528.0, 5000.0]))
    assert abs(lat[0] - flight["pad"]["lat"]) < 0.01 and abs(lon[0] - flight["pad"]["lon"]) < 0.01
    assert alt[0] < 0.5 and 100 < alt[1] < alt[2] and abs(alt[3] - 275) < 1


def test_nodal_period(ift14):
    _, model = ift14
    assert abs(model.nodal_period_s / 60 - 89.748) < 0.01


def test_rejects_an_orbit_that_never_reaches_the_pad():
    with pytest.raises(ValueError):
        FlightModel(pad_lat=28.5, pad_lon=-80.6, inclination=20.0, altitude_km=300)


def test_track_is_placed_in_time_by_t0(ift14):
    _, model = ift14
    track = FlightTrack.from_model(model)
    a = track.ecef(1_800_000_600.0, t0=1_800_000_000.0)
    b = track.ecef(1_800_090_600.0, t0=1_800_090_000.0)
    assert np.allclose(a, b)
    assert np.isnan(track.ecef(1_799_999_000.0, t0=1_800_000_000.0)).all()
