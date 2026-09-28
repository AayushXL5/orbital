"""Human-readable text for notifications."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .astro import compass
from .notify import Note, click_url
from .passes import Pass


def hhmm(t: float, tz: ZoneInfo) -> str:
    return datetime.fromtimestamp(t, tz).strftime("%H:%M")


def day_time(t: float, tz: ZoneInfo) -> str:
    return datetime.fromtimestamp(t, tz).strftime("%a %d %b, %H:%M")


def zone_abbrev(t: float, tz: ZoneInfo) -> str:
    return datetime.fromtimestamp(t, tz).strftime("%Z")


def utc_hms(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M:%S UTC")


def describe_pass(p: Pass, tz: ZoneInfo) -> str:
    """'Look SW at 19:42. Climbs to 64° in the SE at 19:45, gone in the NE by 19:48.'"""
    start, end = p.vis_start or p.start, p.vis_end or p.end
    az0 = p.vis_az_start if p.vis_az_start is not None else p.az_start
    az1 = p.vis_az_end if p.vis_az_end is not None else p.az_end
    top = round(p.vis_max_el if p.vis_max_el is not None else p.max_el)
    text = f"Look {compass(az0)} at {hhmm(start, tz)}. "
    if start <= p.peak <= end:
        text += f"Climbs to {top}° in the {compass(p.az_peak)} at {hhmm(p.peak, tz)}, "
    else:
        text += f"Up to {top}° high, "
    if p.vis_end is not None and p.vis_end < p.end - 20:
        text += f"fades into Earth's shadow in the {compass(az1)} at {hhmm(end, tz)}."
    else:
        text += f"gone in the {compass(az1)} by {hhmm(end, tz)}."
    return text


def pass_note(site_url: str, city, name: str, subject: str, p: Pass, *, kind: str,
              lead_s: float, now: float, sid_prefix: str) -> Note:
    key = p.vis_start if p.vis_start is not None else p.start
    minutes = max(1, round(min(lead_s, key - now) / 60))
    at = key - lead_s
    return Note(
        sequence_id=f"{sid_prefix}-{subject}-{int(key)}"[:64],
        kind=kind,
        key_time=key,
        title=f"{name} over {city.name} in {minutes} min",
        message=describe_pass(p, city.zone),
        click=click_url(site_url, k=kind, o=subject, t=int(key), city=city.id),
        priority=4 if (p.vis_max_el or 0) >= 60 or kind == "flight" else 3,
        at=at if at > now + 30 else None,
    )
