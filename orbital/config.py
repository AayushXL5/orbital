"""Load config.yaml into a small typed object."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class City:
    id: str
    name: str
    lat: float
    lon: float
    tz: str

    @property
    def zone(self) -> ZoneInfo:
        return ZoneInfo(self.tz)


class Config:
    def __init__(self, data: dict, root: Path = ROOT):
        self.raw = data
        self.root = root
        site = data.get("site", {})
        self.site_name = site.get("name", "Orbital")
        self.tagline = site.get("tagline", "")
        self.site_url = site.get("url", "").rstrip("/") + "/"
        self.timezone = ZoneInfo(site.get("timezone", "UTC"))
        self.digest_city_id = site.get("digest_city")

        ntfy = data.get("ntfy", {})
        self.ntfy_server = ntfy.get("server", "https://ntfy.sh").rstrip("/")
        self.topic_prefix = ntfy["topic_prefix"]
        self.telegram_channel_url = (data.get("telegram") or {}).get("channel_url", "")
        self.buttondown_username = ((data.get("email") or {}).get("buttondown_username") or "").strip()

        alerts = data.get("alerts", {})
        self.horizon_hours = float(alerts.get("horizon_hours", 48))
        self.lead_minutes = float(alerts.get("lead_minutes", 10))
        self.min_elevation = float(alerts.get("min_elevation_deg", 10))
        self.min_peak = float(alerts.get("min_peak_deg", 30))
        self.dark_sun = float(alerts.get("dark_sun_deg", -6))
        self.alert_objects = [{"norad": int(o["norad"]), "name": o["name"]} for o in alerts.get("objects", [])]
        flights = alerts.get("flights", {})
        self.flight_lead_minutes = float(flights.get("lead_minutes", 5))
        self.flight_min_peak = float(flights.get("min_peak_deg", 15))

        launches = data.get("launches", {})
        self.reminder_minutes = [int(m) for m in launches.get("reminders_minutes", [60, 10])]
        notable = launches.get("notable", {})
        self.notable_rockets = [s.lower() for s in notable.get("rockets", [])]
        self.notable_countries = [c.upper() for c in notable.get("countries", [])]
        self.notable_crewed = bool(notable.get("crewed", True))

        self.satellite_groups = data.get("satellite_groups", [])
        self.cities = [City(c["id"], c["name"], float(c["lat"]), float(c["lon"]), c["tz"])
                       for c in data.get("cities", [])]

    # Paths
    @property
    def web_dir(self) -> Path:
        return self.root / "web"

    @property
    def data_dir(self) -> Path:
        return self.web_dir / "data"

    @property
    def flights_dir(self) -> Path:
        return self.root / "flights"

    @property
    def cache_dir(self) -> Path:
        return self.root / ".cache"

    # ntfy topics
    def city_topic(self, city: City) -> str:
        return f"{self.topic_prefix}-{city.id}"

    @property
    def launches_topic(self) -> str:
        return f"{self.topic_prefix}-launches"

    @property
    def weekly_topic(self) -> str:
        return f"{self.topic_prefix}-weekly"

    @property
    def digest_city(self) -> City:
        for c in self.cities:
            if c.id == self.digest_city_id:
                return c
        return self.cities[0]

    def city(self, city_id: str) -> City:
        return next(c for c in self.cities if c.id == city_id)


def load_config(path: str | os.PathLike | None = None) -> Config:
    path = Path(path) if path else Path(os.environ.get("ORBITAL_CONFIG", ROOT / "config.yaml"))
    with open(path, encoding="utf-8") as f:
        return Config(yaml.safe_load(f), root=path.resolve().parent)
