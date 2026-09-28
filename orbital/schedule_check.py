"""Decide whether the launch watcher needs to run. Standard library only.

Reads ``data/schedule.json`` from the deployed site and prints ``active=true``
when a notable launch or a planned flight is within the watch window. It
fails open: if the schedule can't be read, the watcher runs.

    python -m orbital.schedule_check [site url]    (defaults to site.url in config.yaml)
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

LOOK_AHEAD = 4.5 * 3600
CONFIG = Path(__file__).resolve().parent.parent / "config.yaml"


def is_active(schedule: dict, now: float) -> bool:
    return any(item["net"] - LOOK_AHEAD <= now <= item["until"] for item in schedule.get("items", []))


def site_url_from_config(path: Path = CONFIG) -> str:
    """The site.url line from config.yaml, without needing PyYAML."""
    in_site = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if re.match(r"^\S", line):
            in_site = line.startswith("site:")
        elif in_site and (m := re.match(r"^\s+url:\s*(\S+)", line)):
            return m.group(1).strip("\"'")
    return ""


def main(argv: list[str]) -> int:
    base = argv[1] if len(argv) > 1 else os.environ.get("SITE_URL") or site_url_from_config()
    url = base.rstrip("/") + "/data/schedule.json"
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            active = is_active(json.load(resp), time.time())
    except Exception as e:  # noqa: BLE001 - any failure means "run the watcher"
        print(f"could not read {url}: {e}", file=sys.stderr)
        active = True
    line = f"active={'true' if active else 'false'}"
    print(line)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write(line + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
