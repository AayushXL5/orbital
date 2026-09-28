"""Orbital uses icons, not emoji. Keep it that way in the UI, messages and pages."""

import re

from conftest import ROOT

EMOJI = re.compile("[\U0001F300-\U0001FAFF\U0001F000-\U0001F2FF☀-➿⬀-⯿★☆️]")
CHECKED = ["orbital/**/*.py", "orbital/templates/*.html", "web/index.html", "web/css/*.css", "web/js/*.js",
           "config.yaml", "flights/*.json"]


def test_no_emoji_anywhere_user_facing():
    hits = []
    for pattern in CHECKED:
        for path in ROOT.glob(pattern):
            for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if EMOJI.search(line):
                    hits.append(f"{path.relative_to(ROOT)}:{n}: {line.strip()[:80]}")
    assert not hits, "\n".join(hits)
