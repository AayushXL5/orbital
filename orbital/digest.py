"""The weekly digest: what's launching, what to look up at, what happened.

``build`` gathers the week (three Launch Library 2 requests and one news
request); ``write`` renders it into web/digest/ (page, JSON, RSS feed);
``send`` pushes it to ntfy, Telegram and email.
"""

from __future__ import annotations

import html
import json
import time
from datetime import datetime
from email.utils import format_datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import sources
from .alerts import alert_objects
from .astro import compass
from .config import Config
from .flights import load_flights, resolve_t0
from .http import Http
from .messages import describe_pass
from .notify import Note, Ntfy, buttondown_send, click_url, send_email, telegram_send
from .passes import find_passes

WEEK = 7 * 86400
TEMPLATES = Path(__file__).parent / "templates"


def _local(ts: float, tz) -> str:
    return datetime.fromtimestamp(ts, tz).strftime("%a %d %b · %H:%M %Z")


def build(cfg: Config, http: Http, now: float | None = None, log=print) -> dict:
    now = time.time() if now is None else now
    tz = cfg.timezone
    upcoming = sources.launches_between(http, now, now + WEEK, limit=60)
    previous = sources.launches_between(http, now - WEEK, now, limit=60)
    events = [e for e in sources.upcoming_events(http, limit=20)
              if e.get("date") and sources.parse_time(e["date"]) <= now + WEEK]
    news = sources.recent_news(http, since=now - WEEK, limit=30)[:10]

    def launch_item(launch):
        net = sources.parse_time(launch["net"])
        rocket, _, mission = launch["name"].partition(" | ")
        return {**launch, "notable": sources.is_notable(launch, cfg), "net_ts": net,
                "short": mission or launch["name"], "vehicle": rocket if mission else launch["rocket"],
                "site": (launch["pad"]["location"] or launch["pad"]["name"]).split(",")[0],
                "when": _local(net, tz) if net else "TBD",
                "link": click_url(cfg.site_url, launch=launch["id"])}

    city = cfg.digest_city
    looks = []
    for name, subject, sat in alert_objects(cfg, http, now, log):
        for p in find_passes(sat.ecef, city.lat, city.lon, now, now + WEEK,
                             min_el=cfg.min_elevation, dark_sun_el=cfg.dark_sun):
            if p.visible and p.vis_max_el >= cfg.min_peak:
                looks.append({"name": name, "start": p.vis_start, "max_el": round(p.vis_max_el),
                              "when": _local(p.vis_start, city.zone), "text": describe_pass(p, city.zone),
                              "direction": f"{compass(p.vis_az_start)} → {compass(p.vis_az_end)}"})
    looks = sorted(sorted(looks, key=lambda x: -x["max_el"])[:6], key=lambda x: x["start"])

    flights = []
    for flight in load_flights(cfg.flights_dir):
        t0, _ = resolve_t0(flight, None)
        if now - WEEK <= t0 <= now + WEEK:
            flights.append({"name": flight["name"], "summary": flight.get("summary", ""),
                            "when": _local(t0, tz), "upcoming": t0 > now,
                            "link": click_url(cfg.site_url, flight=flight["id"])})

    ups = [launch_item(l) for l in upcoming]
    done = [launch_item(l) for l in previous if l["status_id"] in sources.LAUNCHED]
    start_local = datetime.fromtimestamp(now, tz)
    digest = {
        "id": start_local.strftime("%Y-%m-%d"),
        "title": f"This week in space · {start_local.strftime('%d %b')} – "
                 f"{datetime.fromtimestamp(now + WEEK, tz).strftime('%d %b %Y')}",
        "generated": sources.iso(now),
        "site_name": cfg.site_name,
        "site_url": cfg.site_url,
        "timezone": str(tz),
        "launches": ups,
        "notable": [l for l in ups if l["notable"]],
        "results": done,
        "events": [{**e, "when": _local(sources.parse_time(e["date"]), tz)} for e in events],
        "news": news,
        "looks": looks,
        "look_city": city.name,
        "flights": flights,
        "stats": {"launches": len(ups), "notable": sum(l["notable"] for l in ups),
                  "flown": len(done),
                  "succeeded": sum(l["status_id"] == sources.STATUS_SUCCESS for l in done)},
        "subscribe": {"ntfy_weekly": f"{cfg.ntfy_server}/{cfg.weekly_topic}",
                      "ntfy_launches": f"{cfg.ntfy_server}/{cfg.launches_topic}",
                      "telegram": cfg.telegram_channel_url},
    }
    digest["url"] = f"{cfg.site_url}digest/{digest['id']}.html"
    return digest


def render_html(digest: dict) -> str:
    env = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html"]))
    return env.get_template("digest.html").render(d=digest)


def render_text(digest: dict) -> str:
    lines = [digest["title"], ""]
    if digest["launches"]:
        lines.append("LAUNCHES")
        lines += [f"  {l['when']}  {l['short']} ({l['vehicle']}){'  - worth watching' if l['notable'] else ''}"
                  for l in digest["launches"]]
        lines.append("")
    if digest["looks"]:
        lines.append(f"LOOK UP FROM {digest['look_city'].upper()}")
        lines += [f"  {x['when']}  {x['name']}, up to {x['max_el']}°, {x['direction']}" for x in digest["looks"]]
        lines.append("")
    if digest["news"]:
        lines.append("NEWS")
        lines += [f"  {n['title']} — {n['url']}" for n in digest["news"][:6]]
        lines.append("")
    lines.append(f"Full digest: {digest['url']}")
    return "\n".join(lines)


def render_markdown(digest: dict) -> str:
    """The email version: Buttondown renders it into its own template."""
    s = digest["stats"]
    lines = [f"**{s['launches']} launches this week**"
             + (f", {s['notable']} worth watching" if s["notable"] else "")
             + f". Last week {s['flown']} flew and {s['succeeded']} succeeded. Times in {digest['timezone']}.", ""]
    for f in digest["flights"]:
        lines += [f"## {'Coming up' if f['upcoming'] else 'Just flew'}: {f['name']}", "", f"{f['when']}. {f['summary']}",
                  "", f"[{'See the planned orbit' if f['upcoming'] else 'Replay the flight'}]({f['link']})", ""]
    if digest["launches"]:
        lines += ["## Launching this week", ""]
        lines += [f"- **{l['short']}**{' (worth watching)' if l['notable'] else ''}, {l['vehicle']} from {l['site']}, "
                  f"{l['when']}" for l in digest["launches"]]
        lines.append("")
    lines += [f"## Look up from {digest['look_city']}", ""]
    looks = [f"- **{x['when']}**: {x['name']}, up to {x['max_el']}°. {x['text']}" for x in digest["looks"]]
    lines += looks or ["No bright, high passes this week."]
    lines.append("")
    if digest["results"]:
        lines += ["## Last week's launches", ""]
        lines += [f"- {l['short']} ({l['vehicle']}): {l['status_name'] or l['status']}" for l in digest["results"]]
        lines.append("")
    if digest["news"]:
        lines += ["## News", ""]
        lines += [f"- [{n['title']}]({n['url']}), {n['site']}" for n in digest["news"][:8]]
        lines.append("")
    lines.append(f"[Read this digest on the web]({digest['url']}) · [Open Orbital]({digest['site_url']})")
    return "\n".join(lines)


def render_telegram(digest: dict) -> str:
    e = html.escape
    parts = [f"<b>{e(digest['title'])}</b>"]
    if digest["launches"]:
        rows = [f"{e(l['when'])} · " + (f"<b>{e(l['short'])}</b>" if l["notable"] else e(l["short"]))
                for l in digest["launches"][:12]]
        more = len(digest["launches"]) - 12
        parts.append("<b>Launches</b>\n" + "\n".join(rows) + (f"\n…and {more} more" if more > 0 else ""))
    if digest["looks"]:
        rows = [f"• {e(x['when'])} — {e(x['name'])}, up to {x['max_el']}° ({e(x['direction'])})"
                for x in digest["looks"]]
        parts.append(f"<b>Look up from {e(digest['look_city'])}</b>\n" + "\n".join(rows))
    if digest["news"]:
        rows = [f"• <a href=\"{e(n['url'])}\">{e(n['title'])}</a>" for n in digest["news"][:5]]
        parts.append("<b>News</b>\n" + "\n".join(rows))
    parts.append(f"<a href=\"{e(digest['url'])}\">Read the full digest</a>")
    text = "\n\n".join(parts)
    return text if len(text) <= 4000 else text[:3990] + "…"


def render_ntfy(digest: dict) -> tuple[str, str]:
    s = digest["stats"]
    title = f"This week in space: {s['launches']} launches"
    lines = []
    for l in (digest["notable"] or digest["launches"])[:6]:
        lines.append(f"{l['short']} · {l['when']}")
    if digest["looks"]:
        best = max(digest["looks"], key=lambda x: x["max_el"])
        lines.append(f"Best pass over {digest['look_city']}: {best['name']}, {best['when']}, {best['max_el']}°")
    if digest["news"]:
        lines.append(f"Top story: {digest['news'][0]['title']}")
    body = "\n".join(lines) or "A quiet week."
    return title, body.encode("utf-8")[:3800].decode("utf-8", "ignore")


def write(cfg: Config, digest: dict) -> Path:
    out = cfg.web_dir / "digest"
    out.mkdir(parents=True, exist_ok=True)
    page = out / f"{digest['id']}.html"
    page.write_text(render_html(digest), encoding="utf-8")
    (out / f"{digest['id']}.json").write_text(json.dumps(digest, ensure_ascii=False, indent=1), encoding="utf-8")

    index_path = out / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    entry = {"id": digest["id"], "title": digest["title"], "url": f"digest/{digest['id']}.html",
             "generated": digest["generated"], "stats": digest["stats"],
             "highlights": [l["name"] for l in digest["notable"][:5]]}
    index = [entry] + [i for i in index if i["id"] != digest["id"]]
    index_path.write_text(json.dumps(index[:104], ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "feed.xml").write_text(_rss(cfg, index[:20]), encoding="utf-8")
    return page


def _rss(cfg: Config, index: list[dict]) -> str:
    e = html.escape
    items = []
    for i in index:
        when = datetime.fromisoformat(i["generated"].replace("Z", "+00:00"))
        desc = ", ".join(i["highlights"]) or f"{i['stats']['launches']} launches this week"
        items.append(f"<item><title>{e(i['title'])}</title><link>{e(cfg.site_url + i['url'])}</link>"
                     f"<guid>{e(cfg.site_url + i['url'])}</guid><pubDate>{format_datetime(when)}</pubDate>"
                     f"<description>{e(desc)}</description></item>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>'
            f"<title>{e(cfg.site_name)} weekly digest</title><link>{e(cfg.site_url)}</link>"
            f"<description>{e(cfg.tagline)}</description>{''.join(items)}</channel></rss>\n")


def send(cfg: Config, digest: dict, ntfy: Ntfy, dry_run: bool = False, log=print) -> None:
    title, body = render_ntfy(digest)
    ntfy.publish(cfg.weekly_topic, Note(sequence_id=f"w-{digest['id']}", kind="weekly",
                                        key_time=time.time(), title=title, message=body,
                                        click=digest["url"]))
    telegram_send(render_telegram(digest), dry_run=dry_run, log=log)
    buttondown_send(digest["title"], render_markdown(digest), dry_run=dry_run, log=log)
    send_email(digest["title"], render_html(digest), render_text(digest), dry_run=dry_run, log=log)


def record_flown_flights(cfg: Config, http: Http, now: float, log=print) -> list[str]:
    """Write t0_actual into flight files that have flown, so replays keep the right time."""
    updated = []
    for path in sorted(cfg.flights_dir.glob("*.json")):
        flight = json.loads(path.read_text(encoding="utf-8"))
        if flight.get("t0_actual") or not flight.get("ll2_id"):
            continue
        if sources.parse_time(flight["t0"]) > now:
            continue
        launch = sources.launch_by_id(http, flight["ll2_id"])
        if launch["status_id"] in sources.LAUNCHED:
            text = path.read_text(encoding="utf-8")
            anchor = f'"t0": "{flight["t0"]}",'
            if anchor in text:
                text = text.replace(anchor, anchor + f'\n  "t0_actual": "{launch["net"]}",', 1)
                if launch["status_id"] == sources.STATUS_FAILURE:
                    text = text.replace(anchor, anchor + '\n  "outcome": "failure",', 1)
                path.write_text(text, encoding="utf-8")
                updated.append(path.name)
                log(f"  {path.name}: t0_actual {launch['net']}")
    return updated
