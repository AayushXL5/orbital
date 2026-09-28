from orbital.notify import Note, Ntfy, click_url, parse_click, reconcile

NOW = 1_800_000_000.0


def note(key, obj="25544", kind="pass"):
    return Note(sequence_id=f"p-{obj}-{int(key)}", kind=kind, key_time=key, title="ISS over Pune in 10 min",
                message="Look SW.", click=click_url("https://o/", k=kind, o=obj, t=int(key), city="pune"),
                at=key - 600)


def run(ntfy, wanted, **kw):
    return reconcile(ntfy, "topic", wanted, kinds={"pass"}, now=NOW, window_end=NOW + 86400, **kw)


def test_creates_once_then_leaves_alone(ntfy):
    assert run(ntfy, [note(NOW + 5000)]).created == 1
    again = run(ntfy, [note(NOW + 5000)])
    assert (again.created, again.updated, again.unchanged) == (0, 0, 1)


def test_moved_pass_is_republished_under_the_same_id(ntfy):
    run(ntfy, [note(NOW + 5000)])
    moved = note(NOW + 5120)
    res = run(ntfy, [moved])
    assert res.updated == 1 and res.created == 0
    (sid, msg), = ntfy.topics["topic"].items()
    assert sid == f"p-25544-{int(NOW + 5000)}"
    assert parse_click(msg["click"])["t"] == str(int(NOW + 5120))


def test_small_shifts_are_ignored(ntfy):
    run(ntfy, [note(NOW + 5000)])
    assert run(ntfy, [note(NOW + 5030)]).unchanged == 1


def test_vanished_pass_is_cancelled_only_inside_the_window(ntfy):
    run(ntfy, [note(NOW + 5000), note(NOW + 200000)])
    res = run(ntfy, [])
    assert res.cancelled == 1
    assert list(ntfy.topics["topic"]) == [f"p-25544-{int(NOW + 200000)}"]


def test_other_kinds_and_subjects_are_left_alone(ntfy):
    run(ntfy, [note(NOW + 5000)])
    reconcile(ntfy, "topic", [], kinds={"flight"}, now=NOW, window_end=NOW + 86400)
    reconcile(ntfy, "topic", [], kinds={"pass"}, subjects={"48274"}, now=NOW, window_end=NOW + 86400)
    assert len(ntfy.topics["topic"]) == 1


class _Resp:
    status_code = 200
    text = ""

    def raise_for_status(self):
        pass


class _Session:
    def __init__(self):
        self.headers = {}
        self.posts = []

    def request(self, method, url, json=None, timeout=None, **kw):
        self.posts.append((url, json))
        return _Resp()


def test_publish_payload_uses_sequence_id_delay_and_icon():
    session = _Session()
    client = Ntfy("https://ntfy.sh", session=session, icon="https://o/assets/icon-192.png", log=lambda *_: None)
    n = note(NOW + 5000)
    n.at = 4_000_000_000
    client.publish("topic", n)
    url, body = session.posts[0]
    assert url == "https://ntfy.sh"
    assert body["topic"] == "topic" and body["sequence_id"] == n.sequence_id
    assert body["delay"] == "4000000000" and body["icon"].endswith("icon-192.png")
    assert "tags" not in body


def test_dry_run_sends_nothing():
    session = _Session()
    client = Ntfy("https://ntfy.sh", session=session, dry_run=True, log=lambda *_: None)
    client.publish("topic", note(NOW + 5000))
    assert session.posts == [] and client.published == 1
