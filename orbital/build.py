"""Build the data files the site reads (web/data/)."""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from . import __version__, sources
from .astro import ecef_to_geodetic
from .config import Config
from .flights import load_flights, model_and_track, phase, resolve_t0
from .http import Http

LAUNCH_UNTIL = 30 * 60          # keep watching a launch this long after its NET


def _write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


class Builder:
    def __init__(self, cfg: Config, http: Http, now: float | None = None, log=print):
        self.cfg, self.http, self.log = cfg, http, log
        self.now = time.time() if now is None else now
        self.errors: list[str] = []

    def _fallback(self, rel: str, what: str, err: Exception):
        """Keep the live site's copy when an upstream fails."""
        self.errors.append(f"{what}: {err}")
        self.log(f"  {what} failed ({err}); trying the deployed copy")
        try:
            return self.http.get_json(self.cfg.site_url + "data/" + rel)
        except Exception as e2:  # noqa: BLE001
            self.log(f"  no deployed copy either ({e2})")
            return None

    def satellites(self) -> dict:
        counts = {}
        for group in self.cfg.satellite_groups:
            gid = group["id"]
            try:
                records = sources.celestrak_group(self.http, gid)
            except Exception as e:  # noqa: BLE001
                records = self._fallback(f"gp/{gid}.json", f"CelesTrak {gid}", e) or []
            _write(self.cfg.data_dir / "gp" / f"{gid}.json", records)
            counts[gid] = len(records)
        return counts

    def launches(self) -> list[dict]:
        try:
            launches = sources.upcoming_launches(self.http, limit=40)
        except Exception as e:  # noqa: BLE001
            return self._fallback("launches.json", "Launch Library 2 launches", e) or []
        for launch in launches:
            launch["notable"] = sources.is_notable(launch, self.cfg)
        return launches

    def events(self) -> list[dict]:
        try:
            return sources.upcoming_events(self.http, limit=15)
        except Exception as e:  # noqa: BLE001
            return self._fallback("events.json", "Launch Library 2 events", e) or []

    def news(self) -> list[dict]:
        try:
            return sources.recent_news(self.http, limit=20)
        except Exception as e:  # noqa: BLE001
            return self._fallback("news.json", "Spaceflight News API", e) or []

    def flight_launch(self, flight: dict, upcoming: dict[str, dict]) -> dict | None:
        ll2_id = flight.get("ll2_id")
        if not ll2_id:
            return None
        if ll2_id in upcoming:
            return upcoming[ll2_id]
        planned = sources.parse_time(flight["t0"])
        if abs(planned - self.now) > 7 * 86400:
            return None
        try:
            return sources.launch_by_id(self.http, ll2_id)
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"Launch Library 2 {ll2_id}: {e}")
            return None

    def flights(self, upcoming: dict[str, dict]) -> list[dict]:
        index = []
        for flight in load_flights(self.cfg.flights_dir):
            launch = self.flight_launch(flight, upcoming)
            model, track = model_and_track(flight)
            t0, t0_source = resolve_t0(flight, launch)
            lat, lon, alt = ecef_to_geodetic(track.xyz)
            export = {
                "id": flight["id"], "name": flight["name"], "vehicle": flight.get("vehicle", ""),
                "summary": flight.get("summary", ""), "pad": flight["pad"], "source": flight.get("source"),
                "t0_planned": flight["t0"], "window_end": flight.get("window_end"),
                "t0": sources.iso(t0), "t0_source": t0_source,
                "phase": phase(flight, launch, t0, self.now),
                "launch": launch and {k: launch[k] for k in
                                      ("id", "name", "status", "status_name", "net", "window_start",
                                       "window_end", "webcast_live")},
                "model": {**flight["model"], "nodal_period_min": round(model.nodal_period_s / 60, 3)},
                "met_end": track.end_s,
                "phases": {"insertion": model.insertion_s, "deorbit": model.deorbit_s},
                "track": {"dt": float(track.met[1] - track.met[0]),
                          "met": [round(m, 1) for m in track.met.tolist()],
                          "lat": np.round(lat, 4).tolist(), "lon": np.round(lon, 4).tolist(),
                          "alt": np.round(alt, 2).tolist()},
                "events": flight.get("events", []),
            }
            _write(self.cfg.data_dir / "flights" / f"{flight['id']}.json", export)
            index.append({**{k: export[k] for k in ("id", "name", "vehicle", "summary", "t0", "t0_source",
                                                      "phase", "met_end")}, "ll2_id": flight.get("ll2_id")})
        index.sort(key=lambda f: f["t0"], reverse=True)
        _write(self.cfg.data_dir / "flights" / "index.json", index)
        return index

    def site_config(self) -> dict:
        cfg = self.cfg
        return {
            "site": {"name": cfg.site_name, "tagline": cfg.tagline, "url": cfg.site_url},
            "ntfy": {"server": cfg.ntfy_server, "launches_topic": cfg.launches_topic,
                     "weekly_topic": cfg.weekly_topic},
            "telegram": {"channel_url": cfg.telegram_channel_url},
            "email": {"buttondown_username": cfg.buttondown_username},
            "alerts": {"objects": cfg.alert_objects, "lead_minutes": cfg.lead_minutes,
                       "min_peak_deg": cfg.min_peak, "min_elevation_deg": cfg.min_elevation,
                       "dark_sun_deg": cfg.dark_sun},
            "flight_alerts": {"min_peak_deg": cfg.flight_min_peak, "lead_minutes": cfg.flight_lead_minutes},
            "groups": cfg.satellite_groups,
            "cities": [{"id": c.id, "name": c.name, "lat": c.lat, "lon": c.lon, "tz": c.tz,
                        "topic": cfg.city_topic(c)} for c in cfg.cities],
        }

    def run(self) -> dict:
        t_start = time.time()
        self.log("satellites…")
        counts = self.satellites()
        self.log("launches, events, news…")
        launches = self.launches()
        _write(self.cfg.data_dir / "launches.json", launches)
        _write(self.cfg.data_dir / "events.json", self.events())
        _write(self.cfg.data_dir / "news.json", self.news())
        self.log("flights…")
        flights = self.flights({launch["id"]: launch for launch in launches})
        _write(self.cfg.data_dir / "config.json", self.site_config())

        items = [{"kind": "launch", "id": launch["id"], "name": launch["name"],
                  "net": sources.parse_time(launch["net"]),
                  "until": sources.parse_time(launch["net"]) + LAUNCH_UNTIL}
                 for launch in launches
                 if launch.get("notable") and launch["status_id"] not in sources.LAUNCHED and launch.get("net")]
        items += [{"kind": "flight", "id": f["id"], "name": f["name"], "net": sources.parse_time(f["t0"]),
                   "until": sources.parse_time(f["t0"]) + f["met_end"]}
                  for f in flights if f["phase"] in ("planned", "in-flight")]
        _write(self.cfg.data_dir / "schedule.json", {"generated": sources.iso(self.now), "items": items})

        meta = {"generated": sources.iso(self.now), "version": __version__, "errors": self.errors,
                "counts": {"satellites": counts, "launches": len(launches), "flights": len(flights)},
                "seconds": round(time.time() - t_start, 1)}
        _write(self.cfg.data_dir / "meta.json", meta)
        self.log(f"built {self.cfg.data_dir} in {meta['seconds']} s; {len(self.errors)} upstream error(s)")
        return meta
