import json
import shutil
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT))


def load(name: str):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


class FakeNtfy:
    """In-memory ntfy topic store: the latest message per sequence id."""

    def __init__(self):
        self.topics: dict[str, dict[str, dict]] = {}
        self.published = []
        self.deleted = []

    def poll(self, topic):
        return {sid: dict(msg) for sid, msg in self.topics.get(topic, {}).items()}

    def publish(self, topic, note):
        self.topics.setdefault(topic, {})[note.sequence_id] = {
            "event": "message", "sequence_id": note.sequence_id, "title": note.title,
            "message": note.message, "click": note.click, "at": note.at}
        self.published.append((topic, note))

    def delete(self, topic, sequence_id):
        self.topics.get(topic, {}).pop(sequence_id, None)
        self.deleted.append((topic, sequence_id))


class FakeHttp:
    """Answers get_json from fixtures, by URL substring."""

    def __init__(self, routes: dict):
        self.routes = routes
        self.calls = []

    def get_json(self, url, params=None, headers=None, ttl=0, retries=2):
        from orbital.http import HttpError
        self.calls.append((url, params))
        for key, value in self.routes.items():
            if key in url:
                return value(url, params) if callable(value) else value
        raise HttpError(404, url)


@pytest.fixture
def ntfy():
    return FakeNtfy()


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    from orbital.config import Config
    for var in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "SMTP_HOST", "DIGEST_EMAIL_TO"):
        monkeypatch.delenv(var, raising=False)
    shutil.copytree(ROOT / "flights", tmp_path / "flights")
    (tmp_path / "web").mkdir()
    data = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
    return Config(data, root=tmp_path)
