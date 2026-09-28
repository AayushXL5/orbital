// The browser's pass predictions must agree with the Python alert jobs.
// Fixture: python tests/make_js_fixture.py

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { compass, ecefToGeodetic, geodeticToEcef, gmst } from "../../web/js/astro.js";
import { findPasses } from "../../web/js/passes.js";
import { FlightTrack, Satellite } from "../../web/js/sats.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/js_parity.json", import.meta.url), "utf8"));

function compare(js, py, label) {
  assert.equal(js.length, py.length, `${label}: pass count`);
  js.forEach((p, i) => {
    const q = py[i];
    for (const [a, b] of [["start", "start"], ["peak", "peak"], ["end", "end"]]) {
      assert.ok(Math.abs(p[a] - q[b]) < 2, `${label} #${i} ${a}: ${p[a]} vs ${q[b]}`);
    }
    assert.ok(Math.abs(p.maxEl - q.max_el) < 0.05, `${label} #${i} max el ${p.maxEl} vs ${q.max_el}`);
    assert.equal(p.visible, q.visible, `${label} #${i} visible`);
    if (q.visible) {
      assert.ok(Math.abs(p.visStart - q.vis_start) < 6, `${label} #${i} visible start`);
      assert.ok(Math.abs(p.visMaxEl - q.vis_max_el) < 0.2, `${label} #${i} visible max el`);
    }
  });
}

test("ISS passes match the Python pass finder", () => {
  const sat = new Satellite(fx.iss, "stations");
  for (const c of fx.iss_cases) {
    compare(findPasses(sat.fn, c.lat, c.lon, c.t_start, c.t_end), c.passes, `ISS ${c.site}`);
  }
});

test("planned flight passes match the Python pass finder", () => {
  const flight = new FlightTrack(fx.flight);
  for (const c of fx.flight_cases) {
    compare(findPasses(flight.fnFor(), c.lat, c.lon, flight.t0, flight.t0 + flight.endS), c.passes,
      `IFT-14 ${c.site}`);
  }
});

test("flight track is outside its time span", () => {
  const flight = new FlightTrack(fx.flight);
  assert.equal(flight.ecefAtMet(-1), null);
  assert.equal(flight.ecefAtMet(flight.endS + 1), null);
  assert.equal(flight.phaseAt(100), "ascent");
  assert.equal(flight.phaseAt(5000), "orbit");
  assert.equal(flight.phaseAt(33000), "descent");
});

test("geodetic round trip and helpers", () => {
  const g = ecefToGeodetic(geodeticToEcef(18.52, 73.86, 275));
  assert.ok(Math.abs(g.lat - 18.52) < 1e-9 && Math.abs(g.lon - 73.86) < 1e-9 && Math.abs(g.h - 275) < 1e-6);
  assert.equal(compass(0), "N");
  assert.equal(compass(359), "N");
  assert.equal(compass(225), "SW");
  assert.ok(gmst(0) >= 0 && gmst(0) < 2 * Math.PI);
});
