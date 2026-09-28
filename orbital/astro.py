"""Time, reference frames, the Sun and Earth's shadow.

Everything here is vectorised with numpy. Positions are kilometres in the
Earth-fixed frame (ECEF) unless a name says otherwise, and times are Unix
seconds (UTC). UT1-UTC and polar motion are ignored; together they move a
satellite by well under a kilometre, far below what pass prediction needs.

``web/js/astro.js`` mirrors these formulas so the site and the alert jobs
agree; keep the two in step.
"""

from __future__ import annotations

import numpy as np

RE_KM = 6378.137                     # WGS84 equatorial radius
FLATTENING = 1 / 298.257223563
E2 = FLATTENING * (2 - FLATTENING)
OMEGA_EARTH = 7.292115146706979e-5   # rad/s, sidereal rotation rate
MU_EARTH = 398600.4418               # km^3/s^2
J2 = 1.08262668e-3
TWO_PI = 2 * np.pi

COMPASS_POINTS = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")


def unix_to_jd(t):
    return np.asarray(t, dtype=float) / 86400.0 + 2440587.5


def gmst(t):
    """Greenwich mean sidereal time in radians (IAU-82, as SGP4 uses)."""
    tut1 = (unix_to_jd(t) - 2451545.0) / 36525.0
    seconds = (-6.2e-6 * tut1**3 + 0.093104 * tut1**2
               + (876600.0 * 3600 + 8640184.812866) * tut1 + 67310.54841)
    return np.mod(np.deg2rad(seconds / 240.0), TWO_PI)


def inertial_to_ecef(r, t):
    """Rotate TEME vectors of shape (..., 3) into the Earth-fixed frame."""
    theta = gmst(t)
    c, s = np.cos(theta), np.sin(theta)
    x, y, z = r[..., 0], r[..., 1], r[..., 2]
    return np.stack([c * x + s * y, -s * x + c * y, z], axis=-1)


def geodetic_to_ecef(lat_deg, lon_deg, h_km=0.0):
    lat, lon = np.deg2rad(lat_deg), np.deg2rad(lon_deg)
    sin_lat, cos_lat = np.sin(lat), np.cos(lat)
    n = RE_KM / np.sqrt(1 - E2 * sin_lat**2)
    return np.stack([(n + h_km) * cos_lat * np.cos(lon),
                     (n + h_km) * cos_lat * np.sin(lon),
                     (n * (1 - E2) + h_km) * sin_lat], axis=-1)


def ecef_to_geodetic(r):
    """Return (lat_deg, lon_deg, h_km) for Earth-fixed positions."""
    x, y, z = r[..., 0], r[..., 1], r[..., 2]
    p = np.hypot(x, y)
    lon = np.arctan2(y, x)
    lat = np.arctan2(z, p * (1 - E2))
    for _ in range(6):
        sin_lat = np.sin(lat)
        n = RE_KM / np.sqrt(1 - E2 * sin_lat**2)
        h = p * np.cos(lat) + z * sin_lat - RE_KM * np.sqrt(1 - E2 * sin_lat**2)
        lat = np.arctan2(z, p * (1 - E2 * n / (n + h)))
    sin_lat = np.sin(lat)
    h = p * np.cos(lat) + z * sin_lat - RE_KM * np.sqrt(1 - E2 * sin_lat**2)
    return np.rad2deg(lat), np.rad2deg(lon), h


def enu_basis(lat_deg, lon_deg):
    """East, north and up unit vectors of a ground site, in ECEF."""
    lat, lon = np.deg2rad(lat_deg), np.deg2rad(lon_deg)
    sl, cl, so, co = np.sin(lat), np.cos(lat), np.sin(lon), np.cos(lon)
    return (np.array([-so, co, 0.0]),
            np.array([-sl * co, -sl * so, cl]),
            np.array([cl * co, cl * so, sl]))


def look_angles(sat_ecef, obs_ecef, basis):
    """Azimuth (deg from north, clockwise), elevation (deg) and range (km)."""
    d = sat_ecef - obs_ecef
    east, north, up = d @ basis[0], d @ basis[1], d @ basis[2]
    rng = np.sqrt(east**2 + north**2 + up**2)
    with np.errstate(invalid="ignore"):
        el = np.rad2deg(np.arcsin(up / rng))
    az = np.mod(np.rad2deg(np.arctan2(east, north)), 360.0)
    return az, el, rng


def sun_direction_inertial(t):
    """Unit vector to the Sun (Vallado's low-precision formula, ~0.01 deg)."""
    tut1 = (unix_to_jd(t) - 2451545.0) / 36525.0
    mean_lon = 280.460 + 36000.77 * tut1
    mean_anomaly = np.deg2rad(357.5277233 + 35999.05034 * tut1)
    ecliptic_lon = np.deg2rad(mean_lon + 1.914666471 * np.sin(mean_anomaly)
                              + 0.019994643 * np.sin(2 * mean_anomaly))
    obliquity = np.deg2rad(23.439291 - 0.0130042 * tut1)
    return np.stack([np.cos(ecliptic_lon),
                     np.cos(obliquity) * np.sin(ecliptic_lon),
                     np.sin(obliquity) * np.sin(ecliptic_lon)], axis=-1)


def sun_direction_ecef(t):
    return inertial_to_ecef(sun_direction_inertial(t), t)


def sunlit(sat_ecef, sun_dir):
    """True where a satellite is outside Earth's (cylindrical) shadow."""
    along = np.sum(sat_ecef * sun_dir, axis=-1)
    across = np.linalg.norm(sat_ecef - along[..., None] * sun_dir, axis=-1)
    return (along > 0) | (across > RE_KM)


def sun_elevation(sun_dir, up):
    return np.rad2deg(np.arcsin(np.clip(sun_dir @ up, -1.0, 1.0)))


def compass(az_deg: float) -> str:
    return COMPASS_POINTS[int((az_deg % 360.0) / 22.5 + 0.5) % 16]
