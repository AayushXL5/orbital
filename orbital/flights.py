"""Special flights: planned trajectories from ``flights/*.json``.

Launch Library 2 tells us whether and when a flight actually launched; the
flight file tells us where it goes. Together they give the track in time.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from . import sources
from .flightmodel import FlightModel, FlightTrack

REQUIRED = ("name", "pad", "t0", "model")


def load_flights(flights_dir: Path) -> list[dict]:
    flights = []
    for path in sorted(flights_dir.glob("*.json")):
        flight = json.loads(path.read_text(encoding="utf-8"))
        flight.setdefault("id", path.stem)
        missing = [k for k in REQUIRED if k not in flight]
        if missing:
            raise ValueError(f"{path.name}: missing {', '.join(missing)}")
        flights.append(flight)
    return flights


@lru_cache(maxsize=32)
def _track(flight_json: str) -> tuple[FlightModel, FlightTrack]:
    flight = json.loads(flight_json)
    model = FlightModel.from_flight(flight)
    return model, FlightTrack.from_model(model)


def model_and_track(flight: dict) -> tuple[FlightModel, FlightTrack]:
    return _track(json.dumps({k: flight[k] for k in ("pad", "model")}, sort_keys=True))


def resolve_t0(flight: dict, launch: dict | None) -> tuple[float, str]:
    """Launch time to use, and where it came from.

    After liftoff Launch Library 2's ``net`` is the actual liftoff time. Before
    that it is the current target, which beats the date in the flight file.
    Old flights drop out of our Launch Library 2 queries, so the digest job
    records ``t0_actual`` in the flight file once a flight has flown.
    """
    if launch and launch.get("net"):
        source = "actual" if launch["status_id"] in sources.LAUNCHED else "scheduled"
        return sources.parse_time(launch["net"]), source
    if flight.get("t0_actual"):
        return sources.parse_time(flight["t0_actual"]), "actual"
    return sources.parse_time(flight["t0"]), "planned"


def phase(flight: dict, launch: dict | None, t0: float, now: float) -> str:
    _, track = model_and_track(flight)
    status = launch["status_id"] if launch else None
    if status in sources.FAILED or flight.get("outcome") == "failure":
        return "failed"
    flown = status in sources.LAUNCHED or (status is None and (flight.get("t0_actual") or now >= t0))
    if flown:
        return "in-flight" if now < t0 + track.end_s else "complete"
    return "planned"
