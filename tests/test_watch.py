from conftest import load
from orbital import sources, watch

NOW = 1_800_000_000.0


def launch(**kw):
    base = {"id": "11111111-2222-3333-4444-555555555555", "name": "Starship | Flight 15", "mission": "Flight 15",
            "description": "", "mission_type": "Test Flight", "orbit": "LEO", "net": sources.iso(NOW + 50 * 60),
            "net_precision": "Minute", "window_start": None, "window_end": None, "status_id": sources.STATUS_GO,
            "status": "Go", "status_name": "Go for Launch", "provider": "SpaceX", "provider_abbrev": "SpX",
            "rocket": "Starship", "rocket_family": "Starship",
            "pad": {"name": "OLP-2", "lat": 25.99, "lon": -97.15, "location": "Starbase, TX, USA", "country": "US"},
            "image": None, "webcast_live": False, "probability": None, "slug": "x"}
    return {**base, **kw}


def reminder_ids(ntfy, cfg):
    return sorted(ntfy.topics.get(cfg.launches_topic, {}))


def test_reminders_follow_the_launch_time(cfg, ntfy):
    l = launch()
    watch.run(cfg, None, ntfy, now=NOW, launches=[l])
    assert reminder_ids(ntfy, cfg) == ["r-11111111m10"]          # 60 min reminder already passed

    slipped = {**l, "net": sources.iso(NOW + 80 * 60)}
    watch.run(cfg, None, ntfy, now=NOW, launches=[slipped])
    assert reminder_ids(ntfy, cfg) == ["r-11111111m10", "r-11111111m60"]
    assert ntfy.topics[cfg.launches_topic]["r-11111111m10"]["at"] == NOW + 70 * 60

    held = {**slipped, "status_id": sources.STATUS_HOLD, "status": "Hold"}
    watch.run(cfg, None, ntfy, now=NOW, launches=[held])
    assert reminder_ids(ntfy, cfg) == []


def test_ordinary_launches_get_no_reminder(cfg, ntfy):
    plain = launch(name="Falcon 9 | Starlink", rocket="Falcon 9 Block 5", rocket_family="Falcon",
                   mission_type="Communications")
    watch.run(cfg, None, ntfy, now=NOW, launches=[plain])
    assert reminder_ids(ntfy, cfg) == []


def test_liftoff_is_announced_once(cfg, ntfy):
    ift14 = sources.slim_launch(load("ll2_ift14.json")["results"][0])
    t0 = sources.parse_time(ift14["net"])
    first = watch.run(cfg, None, ntfy, now=t0 + 1800, launches=[ift14])
    assert first["rebuild"] is True
    liftoff = [sid for sid in ntfy.topics[cfg.launches_topic] if sid.startswith("x-starship-ift14")]
    assert len(liftoff) == 1
    again = watch.run(cfg, None, ntfy, now=t0 + 2400, launches=[ift14])
    assert again["rebuild"] is False
    assert len([s for s in ntfy.topics[cfg.launches_topic] if s.startswith("x-")]) == 1


def test_no_stale_liftoff_news(cfg, ntfy):
    ift14 = sources.slim_launch(load("ll2_ift14.json")["results"][0])
    t0 = sources.parse_time(ift14["net"])
    result = watch.run(cfg, None, ntfy, now=t0 + 7 * 3600, launches=[ift14])
    assert result["rebuild"] is False
    assert not [s for s in ntfy.topics.get(cfg.launches_topic, {}) if s.startswith("x-")]


def test_failure_cancels_the_flight_alerts(cfg, ntfy):
    ift14 = sources.slim_launch(load("ll2_ift14.json")["results"][0])
    t0 = sources.parse_time(ift14["net"])
    topic = cfg.city_topic(cfg.cities[0])
    ntfy.topics[topic] = {"f-starship-ift14-1": {"event": "message", "sequence_id": "f-starship-ift14-1",
                                                "click": f"https://o/#k=flight&o=starship-ift14&t={int(t0 + 7200)}"}}
    failed = {**ift14, "status_id": sources.STATUS_FAILURE, "status": "Failure"}
    result = watch.run(cfg, None, ntfy, now=t0 + 3600, launches=[failed])
    assert ntfy.topics[topic] == {}
    assert "e-starship-ift14" in ntfy.topics[cfg.launches_topic]
    assert result["rebuild"] is True


def test_messages_have_no_emoji(cfg, ntfy):
    import re
    watch.run(cfg, None, ntfy, now=NOW, launches=[launch()])
    emoji = re.compile("[\U0001F300-\U0001FAFF☀-➿]")
    for _, n in ntfy.published:
        assert not emoji.search(n.title + n.message) and not n.tags
