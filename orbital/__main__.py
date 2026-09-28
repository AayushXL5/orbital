"""Command line: ``python -m orbital <command>``.

build        fetch satellites, launches, events and news; write web/data/
alerts       schedule pass alerts for every city (runs every few hours)
watch        launch reminders and liftoff alerts (runs every ten minutes)
digest       build this week's digest into web/digest/
digest-send  send the newest digest to ntfy, Telegram and email
passes       print upcoming passes for a city id or "lat,lon"
serve        serve web/ on http://localhost:8000
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from .config import load_config
from .http import Http


def _ntfy(cfg, dry_run):
    from .notify import Ntfy
    return Ntfy(cfg.ntfy_server, token=os.environ.get("NTFY_TOKEN"), dry_run=dry_run,
                icon=cfg.site_url + "assets/icon-192.png")


def _output(key: str, value: str):
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write(f"{key}={value}\n")


def _where(cfg, text: str):
    if "," in text:
        lat, lon = (float(x) for x in text.split(","))
        from .config import City
        return City("here", f"{lat:.2f},{lon:.2f}", lat, lon, str(cfg.timezone))
    return cfg.city(text)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m orbital", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", help="path to config.yaml")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build")
    for name in ("alerts", "watch", "digest-send"):
        sub.add_parser(name).add_argument("--dry-run", action="store_true", help="print, don't send")
    dg = sub.add_parser("digest")
    dg.add_argument("--send", action="store_true", help="also send it")
    dg.add_argument("--dry-run", action="store_true")
    ps = sub.add_parser("passes")
    ps.add_argument("where", help='city id from config.yaml, or "lat,lon"')
    ps.add_argument("--hours", type=float, default=48)
    ps.add_argument("--flight", help="a flight id from flights/ instead of the alert objects")
    ps.add_argument("--all", action="store_true", help="include passes you can't see")
    sv = sub.add_parser("serve")
    sv.add_argument("--port", type=int, default=8000)
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    cfg = load_config(args.config)
    http = Http(cache_dir=cfg.cache_dir)

    if args.cmd == "build":
        from .build import Builder
        Builder(cfg, http).run()

    elif args.cmd == "alerts":
        from . import alerts
        totals = alerts.run(cfg, http, _ntfy(cfg, args.dry_run))
        print("total:", totals)

    elif args.cmd == "watch":
        from . import watch
        result = watch.run(cfg, http, _ntfy(cfg, args.dry_run), dry_run=args.dry_run)
        _output("rebuild", "true" if result["rebuild"] else "false")

    elif args.cmd == "digest":
        from . import digest
        d = digest.build(cfg, http)
        page = digest.write(cfg, d)
        print(f"wrote {page}")
        flown = digest.record_flown_flights(cfg, http, time.time())
        if flown:
            print("recorded launch times in", ", ".join(flown))
        if args.send:
            digest.send(cfg, d, _ntfy(cfg, args.dry_run), dry_run=args.dry_run)

    elif args.cmd == "digest-send":
        from . import digest
        index = json.loads((cfg.web_dir / "digest" / "index.json").read_text(encoding="utf-8"))
        if not index:
            print("no digest yet: run `python -m orbital digest` first")
            return 1
        d = json.loads((cfg.web_dir / "digest" / f"{index[0]['id']}.json").read_text(encoding="utf-8"))
        digest.send(cfg, d, _ntfy(cfg, args.dry_run), dry_run=args.dry_run)

    elif args.cmd == "passes":
        _print_passes(cfg, http, args)

    elif args.cmd == "serve":
        import functools
        import http.server
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(cfg.web_dir))
        print(f"serving {cfg.web_dir} on http://localhost:{args.port}")
        http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler).serve_forever()
    return 0


def _print_passes(cfg, http, args):
    from .alerts import alert_objects
    from .astro import compass
    from .flights import load_flights, model_and_track, resolve_t0
    from .messages import day_time
    from .passes import find_passes

    city = _where(cfg, args.where)
    now = time.time()
    if args.flight:
        flight = next(f for f in load_flights(cfg.flights_dir) if f["id"] == args.flight)
        _, track = model_and_track(flight)
        t0, source = resolve_t0(flight, None)
        print(f"{flight['name']}: T0 {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(t0))} ({source})")
        objects = [(flight["name"], lambda t: track.ecef(t, t0), t0, t0 + track.end_s)]
    else:
        objects = [(name, sat.ecef, now, now + args.hours * 3600)
                   for name, _, sat in alert_objects(cfg, http, now)]
    for name, fn, t_start, t_end in objects:
        passes = find_passes(fn, city.lat, city.lon, t_start, t_end,
                             min_el=cfg.min_elevation, dark_sun_el=cfg.dark_sun)
        shown = [p for p in passes if args.all or p.visible]
        print(f"\n{name} over {city.name}: {len(shown)} of {len(passes)} passes")
        for p in shown:
            vis = (f"visible {day_time(p.vis_start, city.zone)[-5:]}–{day_time(p.vis_end, city.zone)[-5:]}, "
                   f"up to {p.vis_max_el:.0f}°") if p.visible else "not visible"
            print(f"  {day_time(p.start, city.zone)}  max {p.max_el:4.1f}°  "
                  f"{compass(p.az_start):>3} → {compass(p.az_end):<3}  {vis}")


if __name__ == "__main__":
    sys.exit(main())
