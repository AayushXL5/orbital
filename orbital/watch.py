"""Launch watcher: reminders before notable launches, alerts once a flight is up.

Runs every ten minutes (``schedule_check`` skips the run when nothing is close,
so most runs never call Launch Library 2).

* Reminders ``reminders_minutes`` before notable launches, scheduled on the
  launches topic. They move when the launch slips and are cancelled on a hold.
* For flights with a planned trajectory (``flights/*.json``):
  - about 3 hours before launch, a heads-up to each city the planned track
    passes over while visible ("if it launches on time...");
  - at liftoff (Launch Library 2 status In Flight or later), a liftoff post
    and per-city pass alerts timed from the actual launch time;
  - if the flight fails, every pending alert for it is cancelled.
"""

from __future__ import annotations

import math
import time

from . import sources
from .config import Config
from .flights import load_flights, model_and_track
from .http import Http
from .messages import describe_pass, hhmm, pass_note, utc_hms, zone_abbrev
from .notify import Note, Ntfy, RateLimited, click_url, reconcile, telegram_send
from .passes import find_passes

WATCH_BEFORE = 4 * 3600
WATCH_AFTER = 12 * 3600
HEADS_UP_BEFORE = 3.5 * 3600
LIFTOFF_NEWS_FOR = 3 * 3600      # after this, "X is up" is old news; pass alerts still go out
REMIND_STATUSES = {sources.STATUS_GO, sources.STATUS_TBC}
EXACT_PRECISION = {"", "Second", "Minute"}


def reminder_notes(cfg: Config, launches: list[dict], now: float) -> list[Note]:
    notes = []
    tz = cfg.timezone
    for launch in launches:
        if not sources.is_notable(launch, cfg) or launch["status_id"] not in REMIND_STATUSES:
            continue
        if launch["net_precision"] not in EXACT_PRECISION:
            continue
        net = sources.parse_time(launch["net"])
        if not net or net - now > WATCH_BEFORE:
            continue
        where = launch["pad"]["location"] or launch["pad"]["name"]
        for minutes in cfg.reminder_minutes:
            at = net - minutes * 60
            if at <= now + 30:
                continue
            subject = f"{launch['id'][:8]}m{minutes}"
            notes.append(Note(
                sequence_id=f"r-{subject}", kind="reminder", key_time=at,
                title=f"{launch['name']} launches in {minutes} min",
                message=(f"{launch['rocket']} from {where} at {hhmm(net, tz)} {zone_abbrev(net, tz)} "
                         f"({utc_hms(net)[:5]} UTC)."
                         + (" Weather is a concern." if (launch.get("probability") or 100) < 50 else "")),
                click=click_url(cfg.site_url, k="reminder", o=subject, t=int(at), launch=launch["id"]),
                priority=4 if minutes <= 10 else 3, at=at))
    return notes


def visible_passes(cfg: Config, track, t0: float, city, t_from: float):
    passes = find_passes(lambda t: track.ecef(t, t0), city.lat, city.lon,
                         max(t_from, t0), t0 + track.end_s,
                         min_el=cfg.min_elevation, dark_sun_el=cfg.dark_sun)
    return [p for p in passes if p.visible and p.vis_max_el >= cfg.flight_min_peak]


def heads_up_note(cfg: Config, flight: dict, city, passes, t0: float) -> Note:
    tz = city.zone
    first = passes[0]
    others = ", ".join(hhmm(p.vis_start, tz) for p in passes[1:4])
    message = (f"If it lifts off on time at {utc_hms(t0)[:5]} UTC "
               f"({hhmm(t0, tz)} {zone_abbrev(t0, tz)}): {describe_pass(first, tz)}")
    if others:
        message += f" More chances at {others}."
    message += " We'll confirm after liftoff."
    return Note(sequence_id=f"h-{flight['id']}-{int(t0)}"[:64], kind="headsup", key_time=t0,
                title=f"{flight['name']} may pass over {city.name}",
                message=message,
                click=click_url(cfg.site_url, k="headsup", o=flight["id"], t=int(t0), city=city.id,
                                flight=flight["id"]),
                priority=3)


def run(cfg: Config, http: Http, ntfy: Ntfy, now: float | None = None,
        launches: list[dict] | None = None, dry_run: bool = False, log=print) -> dict:
    now = time.time() if now is None else now
    if launches is None:
        launches = sources.launches_between(http, now - WATCH_AFTER, now + WATCH_BEFORE)
    result = {"rebuild": False, "reminders": None, "flights": {}}

    try:
        wanted = reminder_notes(cfg, launches, now)
        res = reconcile(ntfy, cfg.launches_topic, wanted, kinds={"reminder"}, now=now + 30,
                        window_end=now + WATCH_BEFORE, match_window=math.inf)
        result["reminders"] = res
        log(f"reminders: {len(wanted)} wanted; +{res.created} ~{res.updated} ={res.unchanged} -{res.cancelled}")

        by_id = {launch["id"]: launch for launch in launches}
        for flight in load_flights(cfg.flights_dir):
            launch = by_id.get(flight.get("ll2_id"))
            if launch:
                result["flights"][flight["id"]] = _flight(cfg, ntfy, flight, launch, now, dry_run, log)
                result["rebuild"] |= result["flights"][flight["id"]].get("rebuild", False)
    except RateLimited as e:
        log(f"{e}; stopping, the next run will catch up")
    return result


def _flight(cfg: Config, ntfy: Ntfy, flight: dict, launch: dict, now: float, dry_run: bool, log) -> dict:
    _, track = model_and_track(flight)
    t0 = sources.parse_time(launch["net"])
    status = launch["status_id"]
    out = {"status": launch["status"], "t0": t0}
    log(f"{flight['name']}: {launch['status']} T0 {utc_hms(t0)}")

    if status in sources.FAILED:
        for city in cfg.cities:
            reconcile(ntfy, cfg.city_topic(city), [], kinds={"flight", "headsup"}, subjects={flight["id"]},
                      now=now, window_end=t0 + track.end_s + 3600, match_window=300)
        note = Note(sequence_id=f"e-{flight['id']}", kind="flightend", key_time=t0,
                    title=f"{flight['name']} ended early",
                    message="The flight did not go as planned, so its pass alerts are cancelled.",
                    click=click_url(cfg.site_url, k="flightend", o=flight["id"], t=int(t0), flight=flight["id"]))
        res = reconcile(ntfy, cfg.launches_topic, [note], kinds={"flightend"}, subjects={flight["id"]},
                        now=now, window_end=now, match_window=math.inf)
        if res.created:
            telegram_send(f"<b>{flight['name']} ended early.</b> Its pass alerts are cancelled.",
                          dry_run=dry_run, log=log)
            out["rebuild"] = True
        return out

    if status in sources.LAUNCHED:
        if now > t0 + track.end_s:
            return out
        summary = []
        for city in cfg.cities:
            passes = visible_passes(cfg, track, t0, city, now + 60)
            notes = [pass_note(cfg.site_url, city, flight["name"], flight["id"], p, kind="flight",
                               lead_s=cfg.flight_lead_minutes * 60, now=now, sid_prefix="f")
                     for p in passes]
            reconcile(ntfy, cfg.city_topic(city), notes, kinds={"flight"}, subjects={flight["id"]},
                      now=now + 60, window_end=t0 + track.end_s, tolerance=30)
            if passes:
                p = passes[0]
                summary.append((p.vis_start, f"{city.name} {hhmm(p.vis_start, city.zone)} "
                                             f"{zone_abbrev(p.vis_start, city.zone)} ({round(p.vis_max_el)}°)"))
        summary = [text for _, text in sorted(summary)]
        site = click_url(cfg.site_url, flight=flight["id"])
        lines = "; ".join(summary[:8]) if summary else "no city on our list gets a visible pass"
        note = Note(sequence_id=f"x-{flight['id']}-{int(t0)}"[:64], kind="liftoff", key_time=t0,
                    title=f"{flight['name']} is up",
                    message=f"Liftoff at {utc_hms(t0)}. Visible passes: {lines}. Tap for the live track.",
                    click=click_url(cfg.site_url, k="liftoff", o=flight["id"], t=int(t0), flight=flight["id"]),
                    priority=4)
        if now - t0 > LIFTOFF_NEWS_FOR:
            return out
        res = reconcile(ntfy, cfg.launches_topic, [note], kinds={"liftoff"}, subjects={flight["id"]},
                        now=now, window_end=now, match_window=math.inf, tolerance=30)
        if res.created:
            items = "\n".join(f"• {s}" for s in summary[:12]) or "No listed city gets a visible pass."
            telegram_send(f"<b>{flight['name']} is up</b>\nLiftoff {utc_hms(t0)}\n\n"
                          f"<b>Where to look up</b>\n{items}\n\n<a href=\"{site}\">Live track</a>",
                          dry_run=dry_run, log=log)
            out["rebuild"] = True
        return out

    # Not launched yet: heads-up when the launch is close and on schedule.
    close = status in REMIND_STATUSES and 0 < t0 - now <= HEADS_UP_BEFORE
    for city in cfg.cities:
        notes = []
        if close:
            passes = visible_passes(cfg, track, t0, city, t0)
            if passes:
                notes.append(heads_up_note(cfg, flight, city, passes, t0))
        reconcile(ntfy, cfg.city_topic(city), notes, kinds={"headsup"}, subjects={flight["id"]},
                  now=now, window_end=now + WATCH_BEFORE, match_window=math.inf, tolerance=300)
    return out
