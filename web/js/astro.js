// Time, frames, the Sun and Earth's shadow. Mirrors orbital/astro.py;
// keep the two in step. Positions are km in the Earth-fixed frame (ECEF),
// times are Unix seconds.

export const RE_KM = 6378.137;
const FLATTENING = 1 / 298.257223563;
export const E2 = FLATTENING * (2 - FLATTENING);
const TWO_PI = 2 * Math.PI;
const DEG = Math.PI / 180;
const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export const unixToJd = (t) => t / 86400 + 2440587.5;

// Greenwich mean sidereal time in radians (IAU-82, as SGP4 uses).
export function gmst(t) {
  const tut1 = (unixToJd(t) - 2451545.0) / 36525.0;
  const seconds = -6.2e-6 * tut1 ** 3 + 0.093104 * tut1 ** 2
    + (876600.0 * 3600 + 8640184.812866) * tut1 + 67310.54841;
  const theta = ((seconds / 240.0) * DEG) % TWO_PI;
  return theta < 0 ? theta + TWO_PI : theta;
}

export function inertialToEcef(r, t) {
  const th = gmst(t), c = Math.cos(th), s = Math.sin(th);
  return [c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]];
}

export function geodeticToEcef(latDeg, lonDeg, hKm = 0) {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const n = RE_KM / Math.sqrt(1 - E2 * sl * sl);
  return [(n + hKm) * cl * Math.cos(lon), (n + hKm) * cl * Math.sin(lon), (n * (1 - E2) + hKm) * sl];
}

export function ecefToGeodetic([x, y, z]) {
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const sl = Math.sin(lat);
    const n = RE_KM / Math.sqrt(1 - E2 * sl * sl);
    h = p * Math.cos(lat) + z * sl - RE_KM * Math.sqrt(1 - E2 * sl * sl);
    lat = Math.atan2(z, p * (1 - E2 * n / (n + h)));
  }
  const sl = Math.sin(lat);
  h = p * Math.cos(lat) + z * sl - RE_KM * Math.sqrt(1 - E2 * sl * sl);
  return { lat: lat / DEG, lon: lon / DEG, h };
}

export function makeSite(lat, lon, hKm = 0) {
  const la = lat * DEG, lo = lon * DEG;
  const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  return {
    lat, lon, ecef: geodeticToEcef(lat, lon, hKm),
    east: [-so, co, 0], north: [-sl * co, -sl * so, cl], up: [cl * co, cl * so, sl],
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Azimuth (deg from north, clockwise), elevation (deg), range (km); null if r is.
export function lookAngles(r, site) {
  if (!r) return null;
  const d = [r[0] - site.ecef[0], r[1] - site.ecef[1], r[2] - site.ecef[2]];
  const e = dot(d, site.east), n = dot(d, site.north), u = dot(d, site.up);
  const range = Math.hypot(e, n, u);
  let az = Math.atan2(e, n) / DEG;
  if (az < 0) az += 360;
  return { az, el: Math.asin(u / range) / DEG, range };
}

// Unit vector to the Sun (Vallado's low-precision formula, ~0.01 deg).
export function sunDirectionInertial(t) {
  const tut1 = (unixToJd(t) - 2451545.0) / 36525.0;
  const meanLon = 280.460 + 36000.77 * tut1;
  const m = (357.5277233 + 35999.05034 * tut1) * DEG;
  const lam = (meanLon + 1.914666471 * Math.sin(m) + 0.019994643 * Math.sin(2 * m)) * DEG;
  const eps = (23.439291 - 0.0130042 * tut1) * DEG;
  return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}

export const sunDirectionEcef = (t) => inertialToEcef(sunDirectionInertial(t), t);

// True when outside Earth's (cylindrical) shadow.
export function sunlit(r, sun) {
  const along = dot(r, sun);
  if (along > 0) return true;
  const across = Math.hypot(r[0] - along * sun[0], r[1] - along * sun[1], r[2] - along * sun[2]);
  return across > RE_KM;
}

export const sunElevation = (sun, up) => Math.asin(Math.max(-1, Math.min(1, dot(sun, up)))) / DEG;

export const compass = (az) => COMPASS_POINTS[Math.floor((((az % 360) + 360) % 360) / 22.5 + 0.5) % 16];
