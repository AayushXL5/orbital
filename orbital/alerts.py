"""Pass alerts: schedule "ISS over Pune in 10 min" pushes for every city.

Runs every few hours. Each run looks ``horizon_hours`` ahead, finds visible
passes that climb above ``min_peak_deg``, and reconciles the city's ntfy topic
with them: new passes are scheduled, moved passes are rescheduled, passes that
vanished (new elements, or no longer visible) are cancelled.
"""

from __future__ import annotations

import json
import time

from . import sources
from .config import Config
from .http import Http
from .messages import pass_note
from .notify import Ntfy, RateLimited, reconcile
from .passes import find_passes
from .satellites import SgpObject

MAX_ELEMENT_AGE_DAYS = 5


def element_sets(cfg: Config, http: Http) -> dict[int, dict]:
    """Element sets for the alert objects, from this build's data if present."""
    found: dict[int, dict] = {}
    for path in sorted((cfg.data_dir / "gp").glob("*.json")):
        for rec in json.loads(path.read_text(encoding="utf-8")):
            found.setdefault(int(rec["NORAD_CAT_ID"]), rec)
    for obj in cfg.alert_objects:
        if obj["norad"] not in found:
            recs = sources.celestrak_catnr(http, obj["norad"])
            if recs:
                found[obj["norad"]] = recs[0]
    return found


def alert_objects(cfg: Config, http: Http, now: float, log=print) -> list[tuple[str, str, SgpObject]]:
    recs = element_sets(cfg, http)
    objects = []
    for obj in cfg.alert_objects:
        rec = recs.get(obj["norad"])
        if rec is None:
            log(f"  no elements for {obj['name']} ({obj['norad']}), skipped")
            continue
        sat = SgpObject(rec)
        age = (now - sat.epoch_unix) / 86400
        if age > MAX_ELEMENT_AGE_DAYS:
            log(f"  elements for {obj['name']} are {age:.1f} days old, skipped")
            continue
        objects.append((obj["name"], str(obj["norad"]), sat))
    return objects


def plan_city(cfg: Config, city, objects, now: float) -> list:
    lead = cfg.lead_minutes * 60
    notes = []
    for name, subject, sat in objects:
        for p in find_passes(sat.ecef, city.lat, city.lon, now + lead + 60, now + cfg.horizon_hours * 3600,
                             min_el=cfg.min_elevation, dark_sun_el=cfg.dark_sun):
            if p.partial or not p.visible or p.vis_max_el < cfg.min_peak:
                continue
            notes.append(pass_note(cfg.site_url, city, name, subject, p, kind="pass",
                                   lead_s=lead, now=now, sid_prefix="p"))
    return notes


def run(cfg: Config, http: Http, ntfy: Ntfy, now: float | None = None, log=print) -> dict:
    now = time.time() if now is None else now
    objects = alert_objects(cfg, http, now, log)
    lead = cfg.lead_minutes * 60
    totals = {"created": 0, "updated": 0, "unchanged": 0, "cancelled": 0}
    for city in cfg.cities:
        wanted = plan_city(cfg, city, objects, now)
        try:
            res = reconcile(ntfy, cfg.city_topic(city), wanted, kinds={"pass"},
                            now=now + lead + 120, window_end=now + (cfg.horizon_hours - 1) * 3600)
        except RateLimited as e:
            log(f"  {e}; stopping, the next run will catch up")
            break
        log(f"{city.name}: {len(wanted)} visible passes; +{res.created} ~{res.updated} "
            f"={res.unchanged} -{res.cancelled}")
        for k in totals:
            totals[k] += getattr(res, k)
    return totals
