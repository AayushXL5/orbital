// Small helpers: DOM, fetching, storage and time formatting.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

export async function getJson(url) {
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return resp.json();
}

// localStorage can be missing or throw (private windows, blocked storage).
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`orbital:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`orbital:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

const fmt = (opts) => new Intl.DateTimeFormat(undefined, opts);
const HM = fmt({ hour: "2-digit", minute: "2-digit" });
const HMS = fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
const DAY = fmt({ weekday: "short", day: "numeric", month: "short" });
const DAY_HM = fmt({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const UTC_HM = fmt({ hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false });

export const hm = (t) => HM.format(new Date(t * 1000));

// "5:19" and "AM" separately, so the period can be set small beside the time.
const HM_PARTS = fmt({ hour: "numeric", minute: "2-digit" });
export function timeParts(t) {
  const parts = HM_PARTS.formatToParts(new Date(t * 1000));
  return {
    time: parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim(),
    period: parts.find((p) => p.type === "dayPeriod")?.value || "",
  };
}
export const hms = (t) => HMS.format(new Date(t * 1000));
export const day = (t) => DAY.format(new Date(t * 1000));
export const dayHm = (t) => DAY_HM.format(new Date(t * 1000));
export const utcHm = (t) => `${UTC_HM.format(new Date(t * 1000))} UTC`;

const pad2 = (n) => String(Math.floor(n)).padStart(2, "0");

// "T−2d 03:14:22", "T−00:09:41", "T+06:46:12"
export function countdown(target, now) {
  const dt = now - target;
  const sign = dt < 0 ? "T−" : "T+";
  let s = Math.abs(dt);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const hmsText = `${pad2(s / 3600)}:${pad2((s % 3600) / 60)}:${pad2(s % 60)}`;
  return d ? `${sign}${d}d ${hmsText}` : `${sign}${hmsText}`;
}

export function relative(t, now) {
  const dt = t - now;
  const a = Math.abs(dt);
  const text = a < 90 ? "a minute" : a < 3600 ? `${Math.round(a / 60)} min`
    : a < 86400 ? `${Math.floor(a / 3600)} h ${Math.round((a % 3600) / 60)} min` : `${Math.round(a / 86400)} days`;
  return dt >= 0 ? `in ${text}` : `${text} ago`;
}

export function duration(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

export const latLonText = (lat, lon) =>
  `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
