// SGP4 satellites (satellite.js) and planned flight tracks, as position functions.

import { json2satrec, propagate } from "satellite.js";
import { geodeticToEcef, inertialToEcef } from "./astro.js";

export class Satellite {
  constructor(record, group) {
    this.record = record;
    this.group = group;
    this.norad = Number(record.NORAD_CAT_ID);
    this.name = record.OBJECT_NAME;
    this.satrec = json2satrec(record);
    this.periodMin = 1440 / Number(record.MEAN_MOTION);
    this.inclination = Number(record.INCLINATION);
    this.epoch = Date.parse(record.EPOCH + "Z") / 1000;
  }

  // TEME position in km at Unix time t, or null.
  eci(t) {
    const pv = propagate(this.satrec, new Date(t * 1000));
    if (!pv || !pv.position || Number.isNaN(pv.position.x)) return null;
    return { r: [pv.position.x, pv.position.y, pv.position.z], v: [pv.velocity.x, pv.velocity.y, pv.velocity.z] };
  }

  ecef(t) {
    const s = this.eci(t);
    return s ? inertialToEcef(s.r, t) : null;
  }

  get fn() {
    return (this._fn ||= (t) => this.ecef(t));
  }
}

// A planned trajectory: Earth-fixed samples by mission elapsed time. The same
// track serves any launch time; t0 only places it in time.
export class FlightTrack {
  constructor(data) {
    this.data = data;
    const tr = data.track;
    this.met = tr.met;
    this.xyz = tr.lat.map((la, i) => geodeticToEcef(la, tr.lon[i], tr.alt[i]));
    this.endS = data.met_end;
    this.t0 = Date.parse(data.t0) / 1000;
    this.insertion = data.phases.insertion;
    this.deorbit = data.phases.deorbit;
  }

  ecefAtMet(m) {
    const met = this.met;
    if (!(m >= 0 && m <= this.endS)) return null;
    let lo = 0, hi = met.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (met[mid] <= m) lo = mid; else hi = mid;
    }
    const f = met[hi] === met[lo] ? 0 : (m - met[lo]) / (met[hi] - met[lo]);
    const a = this.xyz[lo], b = this.xyz[hi];
    return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
  }

  fnFor(t0 = this.t0) {
    return (t) => this.ecefAtMet(t - t0);
  }

  phaseAt(m) {
    if (m < this.insertion) return "ascent";
    if (this.deorbit != null && m >= this.deorbit) return "descent";
    return "orbit";
  }
}
