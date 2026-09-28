"""Find when an object is above a ground site, and when you can actually see it.

``find_passes`` takes any function that maps Unix times to Earth-fixed
positions, so SGP4 satellites and planned flight tracks share one code path.
A pass is *visible* while the object is sunlit, the site is dark (Sun below
``dark_sun_el``) and the object is above ``min_el``.

``web/js/passes.js`` implements the same algorithm for the browser.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Callable

import numpy as np

from . import astro

EcefFn = Callable[[np.ndarray], np.ndarray]


@dataclass
class Pass:
    start: float
    peak: float
    end: float
    max_el: float
    az_start: float
    az_peak: float
    az_end: float
    visible: bool = False
    vis_start: float | None = None
    vis_end: float | None = None
    vis_max_el: float | None = None
    vis_az_start: float | None = None
    vis_az_end: float | None = None
    partial: bool = False

    def to_dict(self) -> dict:
        return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in asdict(self).items()}


class Site:
    def __init__(self, lat: float, lon: float, h_km: float = 0.0):
        self.lat, self.lon, self.h_km = lat, lon, h_km
        self.ecef = astro.geodetic_to_ecef(lat, lon, h_km)
        self.basis = astro.enu_basis(lat, lon)

    def look(self, r):
        return astro.look_angles(r, self.ecef, self.basis)


def _elevation(fn: EcefFn, site: Site, t: float) -> float:
    el = site.look(fn(np.array([t])))[1][0]
    return -90.0 if math.isnan(el) else float(el)


def _crossing(fn, site, lo, hi, min_el, rising):
    """Bisect the time elevation crosses min_el between lo and hi."""
    for _ in range(12):
        mid = 0.5 * (lo + hi)
        above = _elevation(fn, site, mid) >= min_el
        if above == rising:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def _peak(fn, site, lo, hi):
    """Golden-section search for the highest elevation between lo and hi."""
    g = (math.sqrt(5) - 1) / 2
    a, b = lo, hi
    c, d = b - g * (b - a), a + g * (b - a)
    fc, fd = _elevation(fn, site, c), _elevation(fn, site, d)
    for _ in range(24):
        if fc > fd:
            b, d, fd = d, c, fc
            c = b - g * (b - a)
            fc = _elevation(fn, site, c)
        else:
            a, c, fc = c, d, fd
            d = a + g * (b - a)
            fd = _elevation(fn, site, d)
    return 0.5 * (a + b)


def find_passes(fn: EcefFn, lat: float, lon: float, t_start: float, t_end: float, *,
                min_el: float = 10.0, step: float = 20.0, dark_sun_el: float = -6.0,
                h_km: float = 0.0) -> list[Pass]:
    site = Site(lat, lon, h_km)
    t = np.arange(t_start, t_end + step, step)
    _, el, _ = site.look(fn(t))
    el = np.nan_to_num(el, nan=-90.0)
    above = el >= min_el

    edges = np.flatnonzero(np.diff(above.astype(np.int8)))
    starts, ends = [], []
    if above[0]:
        starts.append((t[0], True))
    for i in edges:
        if not above[i]:
            starts.append((_crossing(fn, site, t[i], t[i + 1], min_el, True), False))
        else:
            ends.append((_crossing(fn, site, t[i], t[i + 1], min_el, False), False))
    if above[-1]:
        ends.append((t[-1], True))
    # A grazing pass can rise above min_el and set again between two samples.
    inner = el[1:-1]
    for i in np.flatnonzero((inner >= el[:-2]) & (inner >= el[2:]) & (inner < min_el) & (inner > min_el - 3)) + 1:
        tp = _peak(fn, site, t[i - 1], t[i + 1])
        if _elevation(fn, site, tp) >= min_el:
            starts.append((_crossing(fn, site, t[i - 1], tp, min_el, True), False))
            ends.append((_crossing(fn, site, tp, t[i + 1], min_el, False), False))
    starts.sort()
    ends.sort()

    passes = []
    for (t0, cut0), (t1, cut1) in zip(starts, ends):
        if t1 <= t0:
            continue
        window = t[(t >= t0) & (t <= t1)]
        if len(window):
            k = int(np.argmax(site.look(fn(window))[1]))
            lo, hi = max(t0, window[k] - step), min(t1, window[k] + step)
        else:
            lo, hi = t0, t1
        tp = _peak(fn, site, lo, hi)
        ends_xyz = fn(np.array([t0, tp, t1]))
        az, el3, _ = site.look(ends_xyz)
        p = Pass(start=float(t0), peak=float(tp), end=float(t1), max_el=float(el3[1]),
                 az_start=float(az[0]), az_peak=float(az[1]), az_end=float(az[2]),
                 partial=cut0 or cut1)
        _add_visibility(p, fn, site, min_el, dark_sun_el)
        passes.append(p)
    return passes


def _add_visibility(p: Pass, fn: EcefFn, site: Site, min_el: float, dark_sun_el: float):
    ts = np.linspace(p.start, p.end, max(3, int((p.end - p.start) / 5.0) + 1))
    r = fn(ts)
    az, el, _ = site.look(r)
    sun = astro.sun_direction_ecef(ts)
    lit = astro.sunlit(r, sun)
    dark = astro.sun_elevation(sun, site.basis[2]) < dark_sun_el
    vis = lit & dark & (np.nan_to_num(el, nan=-90.0) >= min_el - 1e-6)
    if not vis.any():
        return
    idx = np.flatnonzero(vis)
    p.visible = True
    p.vis_start, p.vis_end = float(ts[idx[0]]), float(ts[idx[-1]])
    p.vis_max_el = float(np.max(el[idx]))
    if p.vis_start <= p.peak <= p.vis_end:
        p.vis_max_el = max(p.vis_max_el, p.max_el)
    p.vis_az_start, p.vis_az_end = float(az[idx[0]]), float(az[idx[-1]])
