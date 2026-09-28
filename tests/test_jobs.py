"""The build, the pass alerts and the weekly digest, run offline against fixtures."""

import json
import re
import xml.etree.ElementTree as ET

import pytest

from conftest import FakeHttp, load
from orbital import alerts, digest, schedule_check, sources
from orbital.build import Builder

EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿⭐★]")


@pytest.fixture
def http():
    stations = load("gp_stations.json")
    ift14 = load("ll2_ift14.json")["results"][0]
    # The upcoming fixture was captured before liftoff; swap in the flown record.
    upcoming = load("ll2_upcoming.json")
    upcoming["results"] = [ift14 if r["id"] == ift14["id"] else r for r in upcoming["results"]]
    return FakeHttp({
        "celestrak.org": stations,
        "/launches/upcoming/": upcoming,
        f"/launches/{ift14['id']}/": ift14,
        "/launches/": upcoming,
        "/events/upcoming/": load("ll2_events.json"),
        "spaceflightnewsapi": load("snapi_articles.json"),
    })


def iss_epoch():
    rec = next(r for r in load("gp_stations.json") if r["NORAD_CAT_ID"] == 25544)
    from orbital.satellites import SgpObject
    return SgpObject(rec).epoch_unix


def test_build_writes_the_site_data(cfg, http):
    meta = Builder(cfg, http, now=iss_epoch(), log=lambda *_: None).run()
    assert meta["errors"] == []
    data = cfg.data_dir
    for name in ("config.json", "launches.json", "events.json", "news.json", "schedule.json", "meta.json",
                 "gp/stations.json", "flights/index.json", "flights/starship-ift14.json"):
        assert (data / name).exists(), name
    flight = json.loads((data / "flights" / "starship-ift14.json").read_text(encoding="utf-8"))
    assert flight["t0"] == "2026-09-28T12:48:59Z" and flight["t0_source"] == "actual"
    assert len(flight["track"]["lat"]) == len(flight["track"]["met"]) > 3000
    site = json.loads((data / "config.json").read_text(encoding="utf-8"))
    assert site["cities"][0]["topic"].startswith(cfg.topic_prefix)
    assert "token" not in json.dumps(site).lower()


def test_pass_alerts_are_idempotent(cfg, http, ntfy):
    (cfg.data_dir / "gp").mkdir(parents=True)
    (cfg.data_dir / "gp" / "stations.json").write_text(json.dumps(load("gp_stations.json")), encoding="utf-8")
    now = iss_epoch()
    first = alerts.run(cfg, http, ntfy, now=now, log=lambda *_: None)
    assert first["created"] > 0
    for topic, n in ntfy.published:
        assert n.at is None or n.at >= now
        assert n.title.endswith("in 10 min") and not EMOJI.search(n.title + n.message)
    second = alerts.run(cfg, http, ntfy, now=now + 60, log=lambda *_: None)
    assert second["created"] == 0 and second["cancelled"] == 0


def test_digest_renders_everywhere(cfg, http, ntfy):
    d = digest.build(cfg, http, now=iss_epoch(), log=lambda *_: None)
    html = digest.render_html(d)
    assert "Launching This Week" in html and d["look_city"] in html
    tg = digest.render_telegram(d)
    assert len(tg) <= 4096
    title, body = digest.render_ntfy(d)
    assert len(body.encode("utf-8")) <= 4096
    for text in (html, tg, title, body, digest.render_text(d)):
        assert not EMOJI.search(text)
    page = digest.write(cfg, d)
    assert page.exists()
    ET.fromstring((cfg.web_dir / "digest" / "feed.xml").read_text(encoding="utf-8"))
    index = json.loads((cfg.web_dir / "digest" / "index.json").read_text(encoding="utf-8"))
    assert index[0]["id"] == d["id"]
    digest.send(cfg, d, ntfy, dry_run=True, log=lambda *_: None)
    assert ntfy.published[-1][0] == cfg.weekly_topic


def test_schedule_check():
    sched = {"items": [{"net": 1000.0, "until": 2000.0}]}
    assert schedule_check.is_active(sched, 1000.0 - 3600)
    assert schedule_check.is_active(sched, 1500.0)
    assert not schedule_check.is_active(sched, 2001.0)
    assert not schedule_check.is_active(sched, 1000.0 - 5 * 3600)


def test_notable_launches():
    from orbital.config import Config
    import yaml
    from conftest import ROOT
    cfg = Config(yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8")))
    ift14 = sources.slim_launch(load("ll2_ift14.json")["results"][0])
    assert sources.is_notable(ift14, cfg)
    plain = {**ift14, "name": "Falcon 9 | Starlink", "rocket": "Falcon 9", "rocket_family": "Falcon",
             "mission_type": "Communications", "pad": {**ift14["pad"], "country": "US"}}
    assert not sources.is_notable(plain, cfg)
    isro = {**plain, "pad": {**plain["pad"], "country": "IN"}}
    assert sources.is_notable(isro, cfg)


class _Json:
    def __init__(self, data, ok=True):
        self._data, self.ok, self.status_code = data, ok, 200 if ok else 404

    def json(self):
        return self._data

    def raise_for_status(self):
        pass


class _Buttondown:
    def __init__(self, existing=()):
        self.existing = [{"subject": s} for s in existing]
        self.posts = []

    def get(self, url, params=None, headers=None, timeout=None):
        return _Json({"results": self.existing})

    def post(self, url, headers=None, json=None, timeout=None):
        self.posts.append((url, headers, json))
        return _Json({})


def test_email_digest_via_buttondown(cfg, http, monkeypatch):
    from orbital.notify import buttondown_send
    d = digest.build(cfg, http, now=iss_epoch(), log=lambda *_: None)
    md = digest.render_markdown(d)
    assert "## Launching this week" in md and f"## Look up from {d['look_city']}" in md
    assert not md.startswith("---") and not EMOJI.search(md)

    monkeypatch.delenv("BUTTONDOWN_API_KEY", raising=False)
    assert buttondown_send(d["title"], md, session=_Buttondown(), log=lambda *_: None) is False

    monkeypatch.setenv("BUTTONDOWN_API_KEY", "test-key")
    session = _Buttondown()
    assert buttondown_send(d["title"], md, session=session, log=lambda *_: None) is True
    url, headers, body = session.posts[0]
    assert url.endswith("/v1/emails") and headers["Authorization"] == "Token test-key"
    assert body == {"subject": d["title"], "body": md, "status": "about_to_send"}

    rerun = _Buttondown(existing=[d["title"]])
    assert buttondown_send(d["title"], md, session=rerun, log=lambda *_: None) is False
    assert rerun.posts == []
