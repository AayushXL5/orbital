"""Launch Library 2, Spaceflight News API and CelesTrak, trimmed to what we use."""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone

from .http import Http

LL2_BASE = os.environ.get("LL2_BASE", "https://ll.thespacedevs.com/2.3.0").rstrip("/")
SNAPI_BASE = "https://api.spaceflightnewsapi.net/v4"
CELESTRAK_GP = "https://celestrak.org/NORAD/elements/gp.php"

# Launch Library 2 status ids
STATUS_GO, STATUS_TBD, STATUS_SUCCESS, STATUS_FAILURE = 1, 2, 3, 4
STATUS_HOLD, STATUS_IN_FLIGHT, STATUS_PARTIAL, STATUS_TBC, STATUS_DEPLOYED = 5, 6, 7, 8, 9
LAUNCHED = {STATUS_SUCCESS, STATUS_FAILURE, STATUS_IN_FLIGHT, STATUS_PARTIAL, STATUS_DEPLOYED}
FAILED = {STATUS_FAILURE}
CREWED_TYPES = {"human exploration", "tourism"}
CREWED_NAMES = re.compile(r"\b(crew|shenzhou|soyuz ms|gaganyaan|axiom|ax-\d|polaris|artemis i{2,})\b", re.I)

LL2_TTL = 20 * 60
CELESTRAK_TTL = 2 * 3600


def _ll2_headers():
    token = os.environ.get("LL2_TOKEN")
    return {"Authorization": f"Token {token}"} if token else None


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value: str | None) -> float | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def _get(d: dict | None, *path, default=None):
    for key in path:
        if not isinstance(d, dict):
            return default
        d = d.get(key)
    return default if d is None else d


def _image(value) -> str | None:
    if isinstance(value, dict):
        return value.get("thumbnail_url") or value.get("image_url")
    return value or None


def slim_launch(raw: dict) -> dict:
    """The stable, small launch shape the site, digest and watcher share."""
    rocket = _get(raw, "rocket", "configuration", default={})
    families = [f.get("name") for f in rocket.get("families") or [] if f.get("name")]
    pad = raw.get("pad") or {}
    country = _get(pad, "country", "alpha_2_code") or _get(pad, "location", "country", "alpha_2_code")
    mission = raw.get("mission") or {}
    return {
        "id": raw["id"],
        "name": raw.get("name", ""),
        "mission": mission.get("name") or raw.get("name", ""),
        "description": (mission.get("description") or "")[:400],
        "mission_type": mission.get("type") or "",
        "orbit": _get(mission, "orbit", "abbrev", default=""),
        "net": raw.get("net"),
        "net_precision": _get(raw, "net_precision", "name", default=""),
        "window_start": raw.get("window_start"),
        "window_end": raw.get("window_end"),
        "status_id": _get(raw, "status", "id", default=STATUS_TBD),
        "status": _get(raw, "status", "abbrev", default="TBD"),
        "status_name": _get(raw, "status", "name", default=""),
        "provider": _get(raw, "launch_service_provider", "name", default=""),
        "provider_abbrev": _get(raw, "launch_service_provider", "abbrev", default=""),
        "rocket": rocket.get("full_name") or rocket.get("name") or "",
        "rocket_family": families[0] if families else rocket.get("name", ""),
        "pad": {
            "name": pad.get("name", ""),
            "lat": float(pad["latitude"]) if pad.get("latitude") is not None else None,
            "lon": float(pad["longitude"]) if pad.get("longitude") is not None else None,
            "location": _get(pad, "location", "name", default=""),
            "country": country or "",
        },
        "image": _image(raw.get("image")),
        "webcast_live": bool(raw.get("webcast_live")),
        "probability": raw.get("probability"),
        "slug": raw.get("slug", ""),
    }


def is_notable(launch: dict, cfg) -> bool:
    text = " ".join([launch["rocket"], launch["rocket_family"], launch["name"]]).lower()
    if any(r in text for r in cfg.notable_rockets):
        return True
    if launch["pad"]["country"].upper() in cfg.notable_countries:
        return True
    if cfg.notable_crewed and (launch["mission_type"].lower() in CREWED_TYPES
                               or CREWED_NAMES.search(launch["name"])):
        return True
    return False


def upcoming_launches(http: Http, limit: int = 40) -> list[dict]:
    data = http.get_json(f"{LL2_BASE}/launches/upcoming/", {"limit": limit, "mode": "normal"},
                         headers=_ll2_headers(), ttl=LL2_TTL)
    return [slim_launch(r) for r in data["results"]]


def launches_between(http: Http, start: float, end: float, limit: int = 40) -> list[dict]:
    params = {"net__gte": iso(start), "net__lte": iso(end), "limit": limit,
              "mode": "normal", "ordering": "net"}
    data = http.get_json(f"{LL2_BASE}/launches/", params, headers=_ll2_headers(), ttl=LL2_TTL)
    return [slim_launch(r) for r in data["results"]]


def launch_by_id(http: Http, launch_id: str, ttl: float = LL2_TTL) -> dict:
    return slim_launch(http.get_json(f"{LL2_BASE}/launches/{launch_id}/", {"mode": "normal"},
                                     headers=_ll2_headers(), ttl=ttl))


def upcoming_events(http: Http, limit: int = 15) -> list[dict]:
    data = http.get_json(f"{LL2_BASE}/events/upcoming/", {"limit": limit},
                         headers=_ll2_headers(), ttl=LL2_TTL)
    out = []
    for e in data["results"]:
        out.append({
            "id": e["id"],
            "name": e.get("name", ""),
            "type": _get(e, "type", "name", default=""),
            "date": e.get("date"),
            "location": e.get("location") or "",
            "description": (e.get("description") or "")[:300],
            "image": _image(e.get("image") or e.get("feature_image")),
            "webcast_live": bool(e.get("webcast_live")),
        })
    return out


def recent_news(http: Http, since: float | None = None, limit: int = 20) -> list[dict]:
    params = {"limit": limit, "ordering": "-published_at"}
    if since:
        params["published_at_gte"] = iso(since)
    data = http.get_json(f"{SNAPI_BASE}/articles/", params, ttl=LL2_TTL)
    seen, out = set(), []
    for a in data["results"]:
        key = re.sub(r"\W+", " ", a["title"].lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        out.append({"title": a["title"], "url": a["url"], "site": a.get("news_site", ""),
                    "published": a.get("published_at"), "summary": (a.get("summary") or "")[:280],
                    "image": a.get("image_url")})
    return out


def celestrak_group(http: Http, group: str) -> list[dict]:
    data = http.get_json(CELESTRAK_GP, {"GROUP": group, "FORMAT": "json"}, ttl=CELESTRAK_TTL)
    if not isinstance(data, list):
        raise ValueError(f"CelesTrak returned no element sets for {group!r}")
    return data


def celestrak_catnr(http: Http, norad: int) -> list[dict]:
    data = http.get_json(CELESTRAK_GP, {"CATNR": norad, "FORMAT": "json"}, ttl=CELESTRAK_TTL)
    return data if isinstance(data, list) else []
