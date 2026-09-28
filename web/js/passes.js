// Pass prediction for the browser. Same algorithm as orbital/passes.py.
// `fn(t)` maps a Unix time to an Earth-fixed position in km, or null.

import { lookAngles, makeSite, sunDirectionEcef, sunElevation, sunlit } from "./astro.js";

function elevation(fn, site, t) {
  const la = lookAngles(fn(t), site);
  return !la || Number.isNaN(la.el) ? -90 : la.el;
}

function crossing(fn, site, lo, hi, minEl, rising) {
  for (let i = 0; i < 12; i++) {
    const mid = 0.5 * (lo + hi);
    if ((elevation(fn, site, mid) >= minEl) === rising) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}

function peak(fn, site, lo, hi) {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a);
  let fc = elevation(fn, site, c), fd = elevation(fn, site, d);
  for (let i = 0; i < 24; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = elevation(fn, site, c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = elevation(fn, site, d); }
  }
  return 0.5 * (a + b);
}

export function findPasses(fn, lat, lon, tStart, tEnd, { minEl = 10, step = 20, darkSunEl = -6, hKm = 0 } = {}) {
  const site = makeSite(lat, lon, hKm);
  const times = [];
  for (let i = 0; tStart + i * step < tEnd + step; i++) times.push(tStart + i * step);
  const els = times.map((t) => elevation(fn, site, t));
  const above = els.map((el) => el >= minEl);
  const starts = [], ends = [];
  if (above[0]) starts.push([times[0], true]);
  for (let i = 0; i < times.length - 1; i++) {
    if (above[i] === above[i + 1]) continue;
    if (!above[i]) starts.push([crossing(fn, site, times[i], times[i + 1], minEl, true), false]);
    else ends.push([crossing(fn, site, times[i], times[i + 1], minEl, false), false]);
  }
  if (above[above.length - 1]) ends.push([times[times.length - 1], true]);
  // A grazing pass can rise above minEl and set again between two samples.
  for (let i = 1; i < els.length - 1; i++) {
    if (!(els[i] >= els[i - 1] && els[i] >= els[i + 1] && els[i] < minEl && els[i] > minEl - 3)) continue;
    const tp = peak(fn, site, times[i - 1], times[i + 1]);
    if (elevation(fn, site, tp) < minEl) continue;
    starts.push([crossing(fn, site, times[i - 1], tp, minEl, true), false]);
    ends.push([crossing(fn, site, tp, times[i + 1], minEl, false), false]);
  }
  starts.sort((a, b) => a[0] - b[0]);
  ends.sort((a, b) => a[0] - b[0]);

  const passes = [];
  for (let k = 0; k < Math.min(starts.length, ends.length); k++) {
    const [t0, cut0] = starts[k], [t1, cut1] = ends[k];
    if (t1 <= t0) continue;
    let best = -Infinity, bestT = null;
    for (const t of times) {
      if (t < t0 || t > t1) continue;
      const el = elevation(fn, site, t);
      if (el > best) { best = el; bestT = t; }
    }
    const lo = bestT === null ? t0 : Math.max(t0, bestT - step);
    const hi = bestT === null ? t1 : Math.min(t1, bestT + step);
    const tp = peak(fn, site, lo, hi);
    const [a0, ap, a1] = [t0, tp, t1].map((t) => lookAngles(fn(t), site));
    const p = {
      start: t0, peak: tp, end: t1, maxEl: ap.el,
      azStart: a0.az, azPeak: ap.az, azEnd: a1.az,
      visible: false, visStart: null, visEnd: null, visMaxEl: null, visAzStart: null, visAzEnd: null,
      partial: cut0 || cut1, reason: "",
    };
    addVisibility(p, fn, site, minEl, darkSunEl);
    passes.push(p);
  }
  return passes;
}

function addVisibility(p, fn, site, minEl, darkSunEl) {
  const n = Math.max(3, Math.floor((p.end - p.start) / 5) + 1);
  let anyDark = false, anyLit = false;
  for (let i = 0; i < n; i++) {
    const t = p.start + (p.end - p.start) * (i / (n - 1));
    const r = fn(t);
    const la = lookAngles(r, site);
    if (!la) continue;
    const sun = sunDirectionEcef(t);
    const lit = sunlit(r, sun);
    const dark = sunElevation(sun, site.up) < darkSunEl;
    anyDark ||= dark;
    anyLit ||= lit;
    if (!(lit && dark && la.el >= minEl - 1e-6)) continue;
    if (!p.visible) { p.visible = true; p.visStart = t; p.visAzStart = la.az; p.visMaxEl = la.el; }
    p.visEnd = t;
    p.visAzEnd = la.az;
    p.visMaxEl = Math.max(p.visMaxEl, la.el);
  }
  if (p.visible && p.visStart <= p.peak && p.peak <= p.visEnd) p.visMaxEl = Math.max(p.visMaxEl, p.maxEl);
  if (!p.visible) p.reason = anyDark ? "shadow" : "daylight";
}

// Az/el samples across a pass, for the sky chart.
export function passPath(fn, lat, lon, p, step = 5, { darkSunEl = -6 } = {}) {
  const site = makeSite(lat, lon);
  const out = [];
  for (let t = p.start; t <= p.end + 1e-6; t += step) {
    const r = fn(t);
    const la = lookAngles(r, site);
    if (!la) continue;
    const sun = sunDirectionEcef(t);
    out.push({ t, az: la.az, el: la.el, lit: sunlit(r, sun), dark: sunElevation(sun, site.up) < darkSunEl });
  }
  return out;
}
