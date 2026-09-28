// The 3D globe (CesiumJS): Earth with day/night lighting, live satellites,
// the selected satellite's orbit, planned flight tracks and your location.
// Renders on demand: about twice a second while live, every frame in playback.

import { ecefToGeodetic, gmst } from "./astro.js";

const C = window.Cesium;
const FONT = '600 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, "Segoe UI", sans-serif';
const WHITE = "#ffffff", BLUE = "#0a84ff", ORANGE = "#ff9f0a";

const toCartesian = (r, out) => C.Cartesian3.fromElements(r[0] * 1000, r[1] * 1000, r[2] * 1000, out);
const color = (css, alpha = 1) => C.Color.fromCssColorString(css).withAlpha(alpha);
const positionProperty = (fn) =>
  C.CallbackPositionProperty ? new C.CallbackPositionProperty(fn, false) : new C.CallbackProperty(fn, false);
const label = (text, fill = WHITE, extra = {}) => ({
  text, font: FONT, fillColor: color(fill), outlineColor: color("#000000", 0.85), outlineWidth: 3,
  style: C.LabelStyle.FILL_AND_OUTLINE, horizontalOrigin: C.HorizontalOrigin.LEFT,
  pixelOffset: new C.Cartesian2(10, -10), ...extra,
});

export class Globe {
  constructor(container, { onPick }) {
    this.viewer = new C.Viewer(container, {
      baseLayer: C.ImageryLayer.fromProviderAsync(C.SingleTileImageryProvider.fromUrl("assets/earth_day.jpg")),
      baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false, shouldAnimate: true,
      requestRenderMode: true, maximumRenderTimeChange: Infinity,
    });
    const { scene } = this.viewer;
    const night = C.ImageryLayer.fromProviderAsync(C.SingleTileImageryProvider.fromUrl("assets/earth_night.jpg"));
    night.dayAlpha = 0.0;
    night.nightAlpha = 1.0;
    night.brightness = 1.5;
    this.viewer.imageryLayers.add(night);
    scene.globe.enableLighting = true;
    scene.globe.dynamicAtmosphereLighting = true;
    scene.globe.dynamicAtmosphereLightingFromSun = true;
    scene.globe.showGroundAtmosphere = true;
    scene.globe.baseColor = C.Color.BLACK;
    scene.backgroundColor = C.Color.BLACK;
    scene.fog.enabled = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 250_000;
    this.viewer.clock.clockRange = C.ClockRange.UNBOUNDED;

    this.points = scene.primitives.add(new C.PointPrimitiveCollection());
    this.labels = scene.primitives.add(new C.LabelCollection());
    this.entries = [];
    this.groupVisible = {};
    this.selected = null;
    this.ringPositions = [];
    this.groundPositions = [];
    this.lastOrbitUpdate = { wall: 0, sim: 0 };
    this.flight = null;
    this.flightEntities = [];
    this.observer = [];
    this.padEntity = null;
    this.live = true;
    this.listeners = [];

    const e = this.viewer.entities;
    this.orbitEntity = e.add({ show: false, polyline: { positions: new C.CallbackProperty(() => this.ringPositions, false),
      width: 1.2, arcType: C.ArcType.NONE, material: color(WHITE, 0.5) } });
    this.groundEntity = e.add({ show: false, polyline: { positions: new C.CallbackProperty(() => this.groundPositions, false),
      width: 1, arcType: C.ArcType.GEODESIC, material: color(WHITE, 0.2) } });

    const handler = new C.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction((click) => {
      const picked = scene.pick(click.position);
      if (C.defined(picked) && picked.id && picked.id.kind) return onPick(picked.id);
      const cart = this.viewer.camera.pickEllipsoid(click.position, scene.globe.ellipsoid);
      if (!cart) return onPick({ kind: "space" });
      const g = C.Cartographic.fromCartesian(cart);
      onPick({ kind: "globe", lat: C.Math.toDegrees(g.latitude), lon: C.Math.toDegrees(g.longitude) });
    }, C.ScreenSpaceEventType.LEFT_CLICK);

    let lastSim = -Infinity, lastWall = 0;
    this.viewer.clock.onTick.addEventListener(() => {
      if (this.live) this.viewer.clock.currentTime = C.JulianDate.now();
      const t = this.time();
      const wall = performance.now();
      const due = this.live ? wall - lastWall > 500 : Math.abs(t - lastSim) > 0.05 && wall - lastWall > 30;
      if (!due && !this.dirty) return;
      this.dirty = false;
      lastSim = t;
      lastWall = wall;
      this.updateSatellites(t);
      this.updateOrbit(t, wall);
      for (const fn of this.listeners) fn(t);
      scene.requestRender();
    });
  }

  onUpdate(fn) { this.listeners.push(fn); }
  refresh() { this.dirty = true; this.viewer.scene.requestRender(); }

  // Clock ---------------------------------------------------------------
  time() { return C.JulianDate.toDate(this.viewer.clock.currentTime).getTime() / 1000; }

  setLive() {
    this.live = true;
    Object.assign(this.viewer.clock, { multiplier: 1, shouldAnimate: true, currentTime: C.JulianDate.now() });
    this.refresh();
  }

  setTime(t, multiplier) {
    this.live = false;
    const clock = this.viewer.clock;
    clock.currentTime = C.JulianDate.fromDate(new Date(t * 1000));
    if (multiplier != null) clock.multiplier = multiplier;
    clock.shouldAnimate = true;
    this.refresh();
  }

  setSpeed(multiplier) {
    if (multiplier !== 1) this.live = false;
    this.viewer.clock.multiplier = multiplier;
    this.viewer.clock.shouldAnimate = true;
  }

  togglePlay() {
    const clock = this.viewer.clock;
    clock.shouldAnimate = !clock.shouldAnimate;
    if (!clock.shouldAnimate) this.live = false;
    this.refresh();
    return clock.shouldAnimate;
  }

  get playing() { return this.viewer.clock.shouldAnimate; }
  get speed() { return this.viewer.clock.multiplier; }

  // Satellites ----------------------------------------------------------
  setSatellites(sats, groups) {
    this.points.removeAll();
    this.labels.removeAll();
    this.entries = sats.map((sat) => ({
      sat,
      point: this.points.add({ pixelSize: sat.alert ? 6 : 3, color: color(WHITE, sat.alert ? 0.95 : 0.6),
        outlineColor: color("#000000", 0.5), outlineWidth: sat.alert ? 1 : 0, id: { kind: "sat", norad: sat.norad }, show: false }),
      label: sat.alert ? this.labels.add({ ...label(sat.shortName || sat.name), show: false, id: { kind: "sat", norad: sat.norad } }) : null,
      pos: new C.Cartesian3(),
    }));
    for (const g of groups) this.groupVisible[g.id] ??= g.default_on !== false;
    this.refresh();
  }

  setGroupVisible(id, on) {
    this.groupVisible[id] = on;
    this.refresh();
  }

  updateSatellites(t) {
    for (const e of this.entries) {
      const on = this.groupVisible[e.sat.group] || e.sat.alert || e.sat === this.selected;
      const r = on ? e.sat.ecef(t) : null;
      if (!r) {
        e.point.show = false;
        if (e.label) e.label.show = false;
        continue;
      }
      toCartesian(r, e.pos);
      e.point.position = e.pos;
      e.point.show = true;
      if (e.label) { e.label.position = e.pos; e.label.show = true; }
    }
  }

  select(sat) {
    this.selected = sat || null;
    for (const e of this.entries) {
      const isSel = e.sat === this.selected;
      e.point.pixelSize = isSel ? 11 : e.sat.alert ? 6 : 3;
      e.point.color = isSel ? color(BLUE) : color(WHITE, e.sat.alert ? 0.95 : 0.6);
      e.point.outlineColor = color(isSel ? WHITE : "#000000", isSel ? 1 : 0.5);
      e.point.outlineWidth = isSel ? 2 : e.sat.alert ? 1 : 0;
    }
    this.orbitEntity.show = this.groundEntity.show = Boolean(this.selected);
    this.lastOrbitUpdate = { wall: 0, sim: 0 };
    this.refresh();
  }

  updateOrbit(t, wall) {
    const sat = this.selected;
    if (!sat) return;
    if (wall - this.lastOrbitUpdate.wall < 1000 && Math.abs(t - this.lastOrbitUpdate.sim) < 60) return;
    this.lastOrbitUpdate = { wall, sim: t };
    const period = sat.periodMin * 60;
    const th = gmst(t), c = Math.cos(th), s = Math.sin(th);
    const ring = [];
    for (let i = 0; i <= 180; i++) {
      const state = sat.eci(t + (i / 180 - 0.5) * period);
      if (!state) continue;
      const r = state.r;
      ring.push(toCartesian([c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]]));
    }
    this.ringPositions = ring;
    const ground = [];
    for (let dt = -0.5 * period; dt <= 1.5 * period; dt += 30) {
      const r = sat.ecef(t + dt);
      if (!r) continue;
      const g = ecefToGeodetic(r);
      ground.push(C.Cartesian3.fromDegrees(g.lon, g.lat, 0));
    }
    this.groundPositions = ground;
  }

  // Flights -------------------------------------------------------------
  clearFlight() {
    for (const ent of this.flightEntities) this.viewer.entities.remove(ent);
    this.flightEntities = [];
    this.flight = null;
    this.refresh();
  }

  showFlight(track, t0, name) {
    this.clearFlight();
    this.flight = { track, t0 };
    const e = this.viewer.entities;
    const pos = track.xyz.map((r) => toCartesian(r));
    // The whole planned path, dashed; the flown part is drawn solid over it.
    this.flightEntities.push(e.add({ polyline: { positions: pos, width: 1.6, arcType: C.ArcType.NONE,
      material: new C.PolylineDashMaterialProperty({ color: color(ORANGE, 0.7), dashLength: 14 }) } }));
    const flown = () => {
      const m = this.time() - this.flight.t0;
      if (m <= 0) return [];
      const i = track.met.findIndex((x) => x > m);
      const out = pos.slice(0, i === -1 ? pos.length : i);
      const here = track.ecefAtMet(Math.min(m, track.endS));
      if (here) out.push(toCartesian(here));
      return out;
    };
    this.flightEntities.push(e.add({ polyline: { positions: new C.CallbackProperty(flown, false), width: 2.6,
      arcType: C.ArcType.NONE, material: color(ORANGE, 0.95) } }));
    const ground = [];
    for (let i = 0; i < track.data.track.lat.length; i += 6) {
      ground.push(C.Cartesian3.fromDegrees(track.data.track.lon[i], track.data.track.lat[i], 0));
    }
    this.flightEntities.push(e.add({ polyline: { positions: ground, width: 1, arcType: C.ArcType.GEODESIC,
      material: color(ORANGE, 0.16) } }));
    this.flightEntities.push(e.add({
      position: positionProperty((time, result) => {
        const r = track.ecefAtMet(this.time() - this.flight.t0);
        return r ? toCartesian(r, result) : undefined;
      }),
      point: { pixelSize: 11, color: color(ORANGE), outlineColor: color(WHITE), outlineWidth: 2 },
      label: label(name, "#ffd9a0", { pixelOffset: new C.Cartesian2(12, -12) }),
    }));
    const pad = track.data.pad;
    this.flightEntities.push(e.add({ position: C.Cartesian3.fromDegrees(pad.lon, pad.lat, 0),
      point: { pixelSize: 7, color: color("#000000", 0), outlineColor: color(ORANGE), outlineWidth: 2 },
      label: label(pad.name, "#ffd9a0", { pixelOffset: new C.Cartesian2(9, 9),
        distanceDisplayCondition: new C.DistanceDisplayCondition(0, 9_000_000) }) }));
    this.refresh();
  }

  setFlightT0(t0) {
    if (this.flight) this.flight.t0 = t0;
    this.refresh();
  }

  // Places --------------------------------------------------------------
  setObserver(loc) {
    for (const ent of this.observer) this.viewer.entities.remove(ent);
    this.observer = [];
    if (!loc) return this.refresh();
    const at = C.Cartesian3.fromDegrees(loc.lon, loc.lat, 0);
    this.observer.push(this.viewer.entities.add({ position: at,
      point: { pixelSize: 22, color: color(BLUE, 0.22), outlineWidth: 0 } }));
    this.observer.push(this.viewer.entities.add({ position: at,
      point: { pixelSize: 10, color: color(BLUE), outlineColor: color(WHITE), outlineWidth: 2.5 },
      label: label(loc.name || "You", WHITE, { pixelOffset: new C.Cartesian2(12, 0), verticalOrigin: C.VerticalOrigin.CENTER }) }));
    this.refresh();
  }

  showPad(launch) {
    if (this.padEntity) this.viewer.entities.remove(this.padEntity);
    this.padEntity = null;
    if (!launch || launch.pad.lat == null) return this.refresh();
    this.padEntity = this.viewer.entities.add({
      position: C.Cartesian3.fromDegrees(launch.pad.lon, launch.pad.lat, 0),
      point: { pixelSize: 9, color: color(ORANGE), outlineColor: color(WHITE), outlineWidth: 2 },
      label: label(launch.pad.location || launch.pad.name, "#ffd9a0", { pixelOffset: new C.Cartesian2(10, 10) }),
    });
    this.flyTo(launch.pad.lat, launch.pad.lon, 6_000_000);
  }

  flyTo(lat, lon, height = 16_000_000) {
    this.viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(lon, lat, height), duration: 1.4,
      easingFunction: C.EasingFunction.QUADRATIC_IN_OUT });
  }

  viewFrom(lat, lon, height = 16_000_000) {
    this.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, height) });
    this.refresh();
  }
}
