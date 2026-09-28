"""ntfy, Telegram and email delivery.

ntfy does double duty: it delivers the notifications and it remembers what we
already scheduled. Every message we publish carries a sequence id, so a later
run can list the topic, move a message to a new time (republishing with the
same id replaces it) or cancel it (DELETE). The jobs keep no database of
their own.
"""

from __future__ import annotations

import json
import os
import re
import smtplib
import time
from dataclasses import dataclass, field
from email.message import EmailMessage

import requests

from .http import USER_AGENT


class RateLimited(RuntimeError):
    pass


@dataclass
class Note:
    """A notification we want to exist on a topic."""
    sequence_id: str          # [-_A-Za-z0-9]{1,64}
    kind: str                 # groups notes a job owns: pass, flight, reminder, ...
    key_time: float           # the moment the note is about (pass start, launch time)
    title: str
    message: str
    click: str = ""
    tags: list[str] = field(default_factory=list)   # ntfy turns most tags into emoji; we leave them empty
    priority: int = 3
    at: float | None = None   # deliver later (Unix time); None sends now
    markdown: bool = False


SEQ_RE = re.compile(r"^[-_A-Za-z0-9]{1,64}$")


def click_url(base: str, **params) -> str:
    """Site link whose fragment also records the kind and key time for reconciling."""
    frag = "&".join(f"{k}={v}" for k, v in params.items() if v is not None and v != "")
    return f"{base}#{frag}"


def parse_click(click: str) -> dict:
    frag = click.split("#", 1)[1] if "#" in click else ""
    return dict(p.split("=", 1) for p in frag.split("&") if "=" in p)


class Ntfy:
    def __init__(self, server: str, token: str | None = None, dry_run: bool = False,
                 session: requests.Session | None = None, burst: int = 40, interval: float = 5.0,
                 icon: str = "", log=print):
        self.server = server.rstrip("/")
        self.icon = icon
        self.dry_run = dry_run
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        if token:
            self.session.headers["Authorization"] = f"Bearer {token}"
        self.log = log
        self._burst, self._interval = burst, interval
        self._sent = 0
        self._last = 0.0
        self.published = 0

    def _pace(self):
        # ntfy.sh allows a burst of 60 requests, then one every 5 seconds.
        self._sent += 1
        if self._sent > self._burst:
            wait = self._interval - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
        self._last = time.monotonic()

    def _send(self, method: str, url: str, **kw):
        """One request, retried twice on dropped connections and timeouts."""
        for attempt in range(3):
            self._pace()
            try:
                return self.session.request(method, url, timeout=30, **kw)
            except (requests.ConnectionError, requests.Timeout):
                if attempt == 2:
                    raise
                time.sleep(2 * (attempt + 1))

    def _check(self, resp):
        if resp.status_code == 429:
            raise RateLimited(f"ntfy rate limit: {resp.text[:200]}")
        resp.raise_for_status()

    def poll(self, topic: str) -> dict[str, dict]:
        """Latest cached message per sequence id, including scheduled ones."""
        resp = self._send("GET", f"{self.server}/{topic}/json", params={"poll": "1", "sched": "1", "since": "all"})
        self._check(resp)
        latest: dict[str, dict] = {}
        for line in resp.text.splitlines():
            if not line.strip():
                continue
            msg = json.loads(line)
            sid = msg.get("sequence_id") or msg.get("id")
            if msg.get("event") == "message":
                latest[sid] = msg
            elif msg.get("event") == "message_delete":
                latest.pop(sid, None)
        return latest

    def publish(self, topic: str, note: Note):
        if not SEQ_RE.match(note.sequence_id):
            raise ValueError(f"bad sequence id {note.sequence_id!r}")
        body = {"topic": topic, "message": note.message, "title": note.title,
                "sequence_id": note.sequence_id, "priority": note.priority}
        if note.tags:
            body["tags"] = note.tags
        if note.click:
            body["click"] = note.click
        if note.at is not None and note.at > time.time() + 15:
            body["delay"] = str(int(note.at))
        if note.markdown:
            body["markdown"] = True
        if self.icon:
            body["icon"] = self.icon
        when = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(note.at)) if "delay" in body else "now"
        self.log(f"  ntfy {topic} [{note.sequence_id}] {when}: {note.title}")
        self.published += 1
        if self.dry_run:
            return
        self._check(self._send("POST", self.server, json=body))

    def delete(self, topic: str, sequence_id: str):
        self.log(f"  ntfy {topic} [{sequence_id}] cancel")
        if self.dry_run:
            return
        resp = self._send("DELETE", f"{self.server}/{topic}/{sequence_id}")
        if resp.status_code != 404:
            self._check(resp)


@dataclass
class ReconcileResult:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    cancelled: int = 0


def reconcile(ntfy: Ntfy, topic: str, wanted: list[Note], *, kinds: set[str], now: float,
              window_end: float, match_window: float = 300.0, tolerance: float = 60.0,
              subjects: set[str] | None = None,
              existing: dict[str, dict] | None = None) -> ReconcileResult:
    """Make the topic's future notes of ``kinds`` match ``wanted``.

    A wanted note matches an existing one of the same kind and subject when
    their key times are within ``match_window`` seconds; it is republished under
    the existing sequence id if the key time moved by more than ``tolerance``.
    Existing notes that no longer match anything are cancelled if their key
    time falls inside (now, window_end], the span this run is responsible for.
    ``subjects`` limits which existing notes this call may touch.
    """
    result = ReconcileResult()
    if existing is None:
        existing = ntfy.poll(topic)
    mine = {}
    for sid, msg in existing.items():
        info = parse_click(msg.get("click") or "")
        if info.get("k") not in kinds or "t" not in info:
            continue
        if subjects is not None and info.get("o", "") not in subjects:
            continue
        mine[sid] = (info["k"], info.get("o", ""), float(info["t"]))

    for note in wanted:
        subject = parse_click(note.click).get("o", "")
        match = None
        for sid, (kind, obj, key) in mine.items():
            if kind == note.kind and obj == subject and abs(key - note.key_time) <= match_window:
                match = sid
                break
        if match is None:
            ntfy.publish(topic, note)
            result.created += 1
            continue
        _, _, key = mine.pop(match)
        if abs(key - note.key_time) > tolerance:
            note.sequence_id = match
            ntfy.publish(topic, note)
            result.updated += 1
        else:
            result.unchanged += 1

    for sid, (_, _, key) in mine.items():
        if now < key <= window_end:
            ntfy.delete(topic, sid)
            result.cancelled += 1
    return result


def telegram_send(html: str, *, dry_run: bool = False, log=print) -> bool:
    """Post to the configured Telegram chat or channel. Skips if not configured."""
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        log("  telegram: not configured, skipped")
        return False
    log(f"  telegram -> {chat}: {html.splitlines()[0][:80]}")
    if dry_run:
        return True
    resp = requests.post(f"https://api.telegram.org/bot{token}/sendMessage", timeout=30, json={
        "chat_id": chat, "text": html[:4096], "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True}})
    resp.raise_for_status()
    return True


BUTTONDOWN_API = "https://api.buttondown.com/v1/emails"


def buttondown_send(subject: str, markdown: str, *, dry_run: bool = False, log=print,
                    session: requests.Session | None = None) -> bool:
    """Email everyone subscribed through the site's Buttondown form.

    Skips if BUTTONDOWN_API_KEY isn't set, and if an email with this subject
    already exists, so a rerun of the digest job never sends it twice.
    """
    key = os.environ.get("BUTTONDOWN_API_KEY")
    if not key:
        log("  buttondown: not configured, skipped")
        return False
    http = session or requests.Session()
    headers = {"Authorization": f"Token {key}", "User-Agent": USER_AGENT}
    existing = http.get(BUTTONDOWN_API, params={"subject": subject}, headers=headers, timeout=30)
    if existing.ok and any(e.get("subject") == subject for e in existing.json().get("results", [])):
        log(f"  buttondown: '{subject}' was already sent, skipped")
        return False
    log(f"  buttondown -> subscribers: {subject}")
    if dry_run:
        return True
    resp = http.post(BUTTONDOWN_API, headers=headers, timeout=30,
                     json={"subject": subject, "body": markdown, "status": "about_to_send"})
    resp.raise_for_status()
    return True


def send_email(subject: str, html: str, text: str, *, dry_run: bool = False, log=print) -> bool:
    """Send through SMTP_HOST etc. to DIGEST_EMAIL_TO. Skips if not configured."""
    host, to = os.environ.get("SMTP_HOST"), os.environ.get("DIGEST_EMAIL_TO")
    if not host or not to:
        log("  email: not configured, skipped")
        return False
    recipients = [a.strip() for a in to.split(",") if a.strip()]
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get("DIGEST_EMAIL_FROM") or os.environ.get("SMTP_USER", "")
    msg["To"] = ", ".join(recipients)
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    log(f"  email -> {len(recipients)} recipient(s): {subject}")
    if dry_run:
        return True
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=30) as smtp:
        smtp.starttls()
        if os.environ.get("SMTP_USER"):
            smtp.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        smtp.send_message(msg)
    return True
