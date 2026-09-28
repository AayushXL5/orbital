"""Planned trajectories for launches that have no orbital elements yet.

A flight file (``flights/*.json``) gives the pad, the target orbit (circular
altitude and inclination), which branch of the ground track the vehicle takes
from the pad, and a few mission elapsed times (MET). From those we build the
Earth-fixed track:

* orbit: a circular orbit with J2 secular drift whose ground track passes over
  the pad. The vehicle runs ``phase_lag_s`` behind that virtual orbit, because
  it starts from rest; by default the lag is half the time to engine cutoff.
* ascent: the vehicle speeds up along the same ground track and catches the
  orbit's schedule at engine cutoff (``seco_s``), climbing to orbit altitude by
  the insertion burn.
* descent: after the deorbit burn it slows along the track and stops at the
  landing point, if one is given.

The Earth-fixed track depends only on MET, not on the launch time: a later T0
turns the orbit with the Earth, so the same track is flown later under a
different Sun. One sample set therefore serves every launch time in the window.
exoplanet5 used the same approach for Starship IFT-14, fitting the orbit to
the navigational-warning zones (github.com/exoplanet5/Starship-IFT14).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from . import astro


def _cubic_ease(x, slope0):
    """g(0)=0, g(1)=1, g'(0)=slope0, g'(1)=0; monotonic for 0 <= slope0 <= 3."""
    c = min(max(slope0, 0.0), 3.0)
    return c * x + (3 - 2 * c) * x**2 + (c - 2) * x**3


@dataclass
class FlightModel:
    pad_lat: float
    pad_lon: float
    inclination: float
    altitude_km: float
    branch: str = "ascending"          # "ascending" heads north, "descending" south
    seco_s: float = 510.0              # engine cutoff that ends the ascent
    insertion_s: float | None = None   # circularisation burn (defaults to SECO)
    end_s: float = 3 * 5400.0          # last MET to draw
    phase_lag_s: float | None = None
    seco_alt_km: float | None = None
    deorbit_s: float | None = None
    entry_s: float | None = None
    entry_alt_km: float = 120.0
    landing_lat: float | None = None
    landing_lon: float | None = None

    @classmethod
    def from_flight(cls, flight: dict) -> "FlightModel":
        m = flight["model"]
        landing = m.get("landing") or {}
        return cls(
            pad_lat=flight["pad"]["lat"], pad_lon=flight["pad"]["lon"],
            inclination=m["inclination_deg"], altitude_km=m["altitude_km"],
            branch=m.get("branch", "ascending"), seco_s=m.get("seco_s", 510.0),
            insertion_s=m.get("insertion_s"), end_s=m["end_s"],
            phase_lag_s=m.get("phase_lag_s"), seco_alt_km=m.get("seco_alt_km"),
            deorbit_s=m.get("deorbit_s"), entry_s=m.get("entry_s"),
            entry_alt_km=m.get("entry_alt_km", 120.0),
            landing_lat=landing.get("lat"), landing_lon=landing.get("lon"),
        )

    def __post_init__(self):
        if self.branch not in ("ascending", "descending"):
            raise ValueError(f"branch must be ascending or descending, not {self.branch!r}")
        inc = math.radians(self.inclination)
        pad_gc = math.atan((1 - astro.E2) * math.tan(math.radians(self.pad_lat)))
        ratio = math.sin(pad_gc) / math.sin(inc)
        if abs(ratio) > 1:
            raise ValueError(f"an inclination of {self.inclination} deg never reaches "
                             f"the pad latitude {self.pad_lat} deg")
        self._inc = inc
        self._u_pad = math.asin(ratio) if self.branch == "ascending" else math.pi - math.asin(ratio)
        self._alpha_pad = math.atan2(math.sin(self._u_pad) * math.cos(inc), math.cos(self._u_pad))

        a = astro.RE_KM + self.altitude_km
        n = math.sqrt(astro.MU_EARTH / a**3)
        k = 1.5 * astro.J2 * (astro.RE_KM / a) ** 2
        self._u_dot = n * (1 + k * (4 * math.cos(inc) ** 2 - 1))
        self._node_dot = -n * k * math.cos(inc)

        if self.insertion_s is None or self.insertion_s < self.seco_s:
            self.insertion_s = self.seco_s
        lag = self.phase_lag_s if self.phase_lag_s is not None else self.seco_s / 2
        self._lag = min(max(lag, 1.0), 2 * self.seco_s / 3)
        if self.seco_alt_km is None:
            self.seco_alt_km = 0.6 * self.altitude_km
        if self.deorbit_s is not None and self.entry_s is None:
            self.entry_s = self.deorbit_s + 0.63 * (self.end_s - self.deorbit_s)
        self._landing = None
        if self.deorbit_s is not None and self.landing_lat is not None:
            self._landing = self._fit_landing()

    @property
    def nodal_period_s(self) -> float:
        return 2 * math.pi / self._u_dot

    # Track geometry, as a function of the virtual orbit's time since it
    # crossed the pad (sigma, seconds).
    def _track_dir(self, sigma):
        sigma = np.asarray(sigma, dtype=float)
        u = self._u_pad + self._u_dot * sigma
        alpha = np.arctan2(np.sin(u) * math.cos(self._inc), np.cos(u))
        lon = (math.radians(self.pad_lon) + alpha - self._alpha_pad
               + (self._node_dot - astro.OMEGA_EARTH) * sigma)
        lat = np.arcsin(math.sin(self._inc) * np.sin(u))
        return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], axis=-1)

    def _fit_landing(self):
        """Place the descent so it ends on the landing point.

        The vehicle coasts at orbital speed from the deorbit burn to entry,
        then slows to a stop with speed (1 - x)^p, p chosen so the distance
        flown lands it on target. Returns what ``sigma`` needs.
        """
        target = astro.geodetic_to_ecef(self.landing_lat, self.landing_lon)
        target = target / np.linalg.norm(target)
        s0 = self.deorbit_s - self._lag
        span = self.end_s - self.deorbit_s
        grid = s0 + np.arange(0.0, 1.5 * span, 5.0)
        dots = self._track_dir(grid) @ target
        s_land = float(grid[int(np.argmax(dots))])
        miss_deg = math.degrees(math.acos(min(1.0, float(np.max(dots)))))
        if miss_deg > 5:
            raise ValueError(f"landing point is {miss_deg:.1f} deg off the ground track")
        coast = self.entry_s - self.deorbit_s
        glide_fraction = (s_land - s0 - coast) / (self.end_s - self.entry_s)
        return {
            "s0": s0, "s_land": s_land, "coast": coast,
            "offset": target - self._track_dir(s_land),
            "glide_p": 1 / glide_fraction - 1 if 0.05 < glide_fraction < 0.95 else None,
            "ease_slope": span / max(s_land - s0, 1.0),
        }

    def sigma(self, met):
        """Virtual-orbit time for each MET (the vehicle's place along the track)."""
        met = np.asarray(met, dtype=float)
        s, lag = self.seco_s, self._lag
        a, b = (2 * lag - s) / s**3, (2 * s - 3 * lag) / s**2
        out = np.where(met <= s, a * met**3 + b * met**2, met - lag)
        fit = self._landing
        if fit is None:
            return out
        s0, s_land = fit["s0"], fit["s_land"]
        if fit["glide_p"] is not None:
            p, glide = fit["glide_p"], self.end_s - self.entry_s
            x = np.clip((met - self.entry_s) / glide, 0.0, 1.0)
            flown = glide * (1 - (1 - x) ** (p + 1)) / (p + 1)
            descent = np.where(met <= self.entry_s, s0 + (met - self.deorbit_s), s0 + fit["coast"] + flown)
        else:
            x = np.clip((met - self.deorbit_s) / (self.end_s - self.deorbit_s), 0.0, 1.0)
            descent = s0 + (s_land - s0) * _cubic_ease(x, fit["ease_slope"])
        return np.where(met > self.deorbit_s, descent, out)

    def altitude(self, met):
        met = np.asarray(met, dtype=float)
        h, h_seco = self.altitude_km, self.seco_alt_km
        x_up = np.clip(met / self.seco_s, 0.0, 1.0)
        out = h_seco * (1 - (1 - x_up) ** 2)
        if self.insertion_s > self.seco_s:
            x = np.clip((met - self.seco_s) / (self.insertion_s - self.seco_s), 0.0, 1.0)
            coast = h_seco + (h - h_seco) * np.sin(0.5 * np.pi * x)
            out = np.where(met > self.seco_s, coast, out)
        else:
            out = np.where(met > self.seco_s, h, out)
        out = np.where(met >= self.insertion_s, h, out)
        if self.deorbit_s is not None:
            x1 = np.clip((met - self.deorbit_s) / (self.entry_s - self.deorbit_s), 0.0, 1.0)
            to_entry = self.entry_alt_km + (h - self.entry_alt_km) * 0.5 * (1 + np.cos(np.pi * x1))
            x2 = np.clip((met - self.entry_s) / (self.end_s - self.entry_s), 0.0, 1.0)
            glide = self.entry_alt_km * (1 - x2**1.5)
            out = np.where(met > self.deorbit_s, np.where(met > self.entry_s, glide, to_entry), out)
        return out

    def ecef(self, met):
        """Earth-fixed position (N, 3) in km at each MET."""
        met = np.atleast_1d(np.asarray(met, dtype=float))
        sigma = self.sigma(met)
        d = self._track_dir(sigma)
        fit = self._landing
        if fit is not None:
            # Bend the descent onto the landing point in proportion to progress.
            progress = np.clip((sigma - fit["s0"]) / (fit["s_land"] - fit["s0"]), 0.0, 1.0)
            w = np.where(met > self.deorbit_s, progress, 0.0)
            d = d + w[:, None] * fit["offset"]
            d = d / np.linalg.norm(d, axis=-1, keepdims=True)
        lat_gc = np.arcsin(d[:, 2])
        surface = astro.RE_KM * np.sqrt((1 - astro.E2) / (1 - astro.E2 * np.cos(lat_gc) ** 2))
        return d * (surface + self.altitude(met))[:, None]

    def phase_names(self, met):
        met = np.asarray(met, dtype=float)
        names = np.full(met.shape, "orbit", dtype=object)
        names[met < self.insertion_s] = "ascent"
        if self.deorbit_s is not None:
            names[met >= self.deorbit_s] = "descent"
        return names


class FlightTrack:
    """Sampled Earth-fixed track, placed in time by a launch time T0."""

    def __init__(self, met: np.ndarray, ecef: np.ndarray):
        self.met = np.asarray(met, dtype=float)
        self.xyz = np.asarray(ecef, dtype=float)

    @classmethod
    def from_model(cls, model: FlightModel, dt: float = 10.0) -> "FlightTrack":
        met = np.arange(0.0, model.end_s, dt)
        met = np.append(met, model.end_s)
        return cls(met, model.ecef(met))

    @property
    def end_s(self) -> float:
        return float(self.met[-1])

    def ecef(self, t, t0: float) -> np.ndarray:
        """Positions (N, 3) at Unix times t; NaN before liftoff and after the end."""
        m = np.atleast_1d(np.asarray(t, dtype=float)) - t0
        cols = [np.interp(m, self.met, self.xyz[:, k], left=np.nan, right=np.nan) for k in range(3)]
        return np.stack(cols, axis=-1)
