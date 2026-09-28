"""HTTP with a polite User-Agent, retries and an optional on-disk cache.

The cache keeps local development inside the upstream limits (Launch Library 2
allows 15 anonymous requests an hour; CelesTrak asks for no more than one
download of a group every two hours). CI runs start with an empty cache.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import requests

from . import __version__

USER_AGENT = f"orbital/{__version__} (+https://github.com/AayushXL5/orbital)"


class HttpError(RuntimeError):
    def __init__(self, status: int, url: str, body: str = ""):
        super().__init__(f"HTTP {status} for {url}: {body[:200]}")
        self.status = status


class Http:
    def __init__(self, cache_dir: Path | None = None, session: requests.Session | None = None):
        self.cache_dir = cache_dir
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT

    def get_json(self, url: str, params: dict | None = None, headers: dict | None = None,
                 ttl: float = 0, retries: int = 2):
        cache_file = self._cache_file(url, params) if ttl > 0 and self.cache_dir else None
        if cache_file and cache_file.exists() and time.time() - cache_file.stat().st_mtime < ttl:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        for attempt in range(retries + 1):
            try:
                resp = self.session.get(url, params=params, headers=headers, timeout=30)
            except (requests.ConnectionError, requests.Timeout):
                if attempt == retries:
                    raise
                time.sleep(2 * (attempt + 1))
                continue
            if resp.status_code < 500 or attempt == retries:
                break
            time.sleep(2 * (attempt + 1))
        if resp.status_code != 200:
            raise HttpError(resp.status_code, resp.url, resp.text)
        data = resp.json()
        if cache_file:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(data), encoding="utf-8")
        return data

    def _cache_file(self, url: str, params: dict | None) -> Path:
        key = url + "?" + json.dumps(params or {}, sort_keys=True)
        return self.cache_dir / "http" / (hashlib.sha1(key.encode()).hexdigest()[:20] + ".json")
