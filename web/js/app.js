// Orbital: loads what the build wrote to data/, drives the globe and the panel.

import { compass, ecefToGeodetic, inertialToEcef, sunDirectionEcef, sunlit } from "./astro.js";
import { Globe } from "./globe.js";
import { download, toIcs } from "./ics.js";
import { icons } from "./icons.js";
import { findPasses, passPath } from "./passes.js";
import { FlightTrack, Satellite } from "./sats.js";
import { Sheet } from "./sheet.js";
import { skyChartSvg } from "./skychart.js";
import {
  $, $$, countdown, day, dayHm, distanceKm, duration, esc, getJson, hm, hms, latLonText, relative, store, timeParts, utcHm,
} from "./util.js";

const TABS = [
  { id: "sky", label: "Sky" },
  { id: "launches", label: "Launches" },
  { id: "flights", label: "Flights" },
  { id: "digest", label: "Digest" },
  { id: "alerts", label: "Alerts" },
];
const SPEEDS = [1, 10, 60, 300, 1200];
const PASS_DAYS = 3;
const LAUNCHED = new Set(["Success", "Failure", "In Flight", "Partial Failure", "Deployed"]);

const state = {
  cfg: null,
  sats: [], byNorad: new Map(),
  launches: [], flights: [], tracks: new Map(), news: [], digests: [],
  loc: store.get("location"),
  tab: TABS.some((t) => t.id === store.get("tab")) ? store.get("tab") : "sky",
  stacks: Object.fromEntries(TABS.map((t) => [t.id, [{ v: t.id }]])),
  showAll: false,
  passes: [], entries: new Map(),
  selected: null,
  flightId: null, flightT0: null,
  launchFilter: store.get("launchFilter", "notable"),
  hudOpen: false, scrubbing: false, picking: false,
};
let globe, sheet;
const compact = matchMedia("(max-width: 899px) and (min-height: 501px)");
const body = () => $("#panel-body");
const now = () => Date.now() / 1000;

// Startup -------------------------------------------------------------------

async function main() {
  try {
    state.cfg = await getJson("data/config.json");
  } catch {
    return fatal("No data yet. Run <code>python -m orbital build</code>, then reload this page.");
  }
  if (!window.Cesium) return fatal("The globe couldn't load. Check your connection and reload.");
  const optional = (path) => getJson(path).catch(() => null);
  const [launches, flights, news, digests] = await Promise.all([
    optional("data/launches.json"), optional("data/flights/index.json"),
    optional("data/news.json"), optional("digest/index.json"),
  ]);
  Object.assign(state, { launches: launches || [], flights: flights || [], news: news || [], digests: digests || [] });
  await loadSatellites();
  await Promise.all(state.flights.filter((f) => f.phase !== "complete").map((f) => loadTrack(f.id)));

  globe = new Globe($("#globe"), { onPick });
  globe.setSatellites(state.sats, state.cfg.groups);
  globe.onUpdate(onGlobeUpdate);
  if (state.loc) globe.setObserver(state.loc);
  globe.viewFrom(state.loc?.lat ?? 21, state.loc?.lon ?? 79);

  sheet = new Sheet($("#panel"), $("#sheet-handle"), $("#grabber"), {
    onChange: (detent) => {
      document.body.classList.remove("sheet-small", "sheet-medium", "sheet-large");
      document.body.classList.add(`sheet-${detent}`);
    },
  });
  sheet.enable(compact.matches);
  compact.addEventListener("change", (e) => sheet.enable(e.matches));

  buildChrome();
  bindEvents();
  computePasses();
  showTab(state.tab);
  await applyHash();
  tick();
  setInterval(tick, 1000);
  document.body.classList.add("ready");
}

async function loadSatellites() {
  const alerts = new Map(state.cfg.alerts.objects.map((o) => [o.norad, o.name]));
  const lists = await Promise.all(state.cfg.groups.map((g) => getJson(`data/gp/${g.id}.json`).catch(() => [])));
  state.cfg.groups.forEach((g, i) => {
    for (const rec of lists[i]) {
      const norad = Number(rec.NORAD_CAT_ID);
      if (state.byNorad.has(norad)) continue;
      try {
        const sat = new Satellite(rec, g.id);
        sat.alert = alerts.has(norad);
        sat.shortName = alerts.get(norad);
        state.sats.push(sat);
        state.byNorad.set(norad, sat);
      } catch { /* skip element sets SGP4 rejects */ }
    }
  });
  const list = document.createElement("datalist");
  list.id = "sat-names";
  list.innerHTML = state.sats.map((s) => `<option value="${esc(s.name)} · ${s.norad}">`).join("");
  document.body.append(list);
}

async function loadTrack(id) {
  if (!state.tracks.has(id)) state.tracks.set(id, new FlightTrack(await getJson(`data/flights/${id}.json`)));
  return state.tracks.get(id);
}

function fatal(html) {
  $("#fatal").innerHTML = html;
  $("#fatal").hidden = false;
}

function buildChrome() {
  $("#segmented").innerHTML = `<span class="thumb" aria-hidden="true"></span>` + TABS.map((t, i) =>
    `<button role="tab" data-tab="${t.id}" style="--n:${i}" aria-selected="false">${t.label}</button>`).join("");
  $("#tabbar").innerHTML = TABS.map((t) =>
    `<button role="tab" data-tab="${t.id}" aria-selected="false">${icons[t.id]}<span>${t.label}</span></button>`).join("");
  $("#btn-locate").innerHTML = icons.location;
  $("#btn-time").innerHTML = icons.clock;
  $("#btn-layers").innerHTML = icons.layers;
  $("#hud-back").innerHTML = icons.back;
  $("#hud-speed").innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join("");
  $("#loc-close").innerHTML = icons.close;
  $("#loc-geo-icon").innerHTML = icons.location;
  $("#loc-pick-icon").innerHTML = icons.globe;
}

// Passes ---------------------------------------------------------------------

const passOpts = () => ({ minEl: state.cfg.alerts.min_elevation_deg, darkSunEl: state.cfg.alerts.dark_sun_deg });

function register(entry) {
  const key = `${entry.subject}:${Math.round(entry.p.start)}`;
  state.entries.set(key, entry);
  entry.key = key;
  return entry;
}

function computePasses() {
  state.passes = [];
  if (state.loc) {
    const t = now();
    const { lat, lon } = state.loc;
    for (const o of state.cfg.alerts.objects) {
      const sat = state.byNorad.get(o.norad);
      if (!sat) continue;
      for (const p of findPasses(sat.fn, lat, lon, t - 900, t + PASS_DAYS * 86400, passOpts())) {
        state.passes.push(register({ name: o.name, subject: String(o.norad), sat, fn: sat.fn, p }));
      }
    }
    for (const f of state.flights) {
      const track = state.tracks.get(f.id);
      if (!track || f.phase === "failed" || track.t0 + track.endS < t || track.t0 > t + PASS_DAYS * 86400) continue;
      const fn = track.fnFor(track.t0);
      for (const p of findPasses(fn, lat, lon, Math.max(track.t0, t - 900), track.t0 + track.endS, passOpts())) {
        state.passes.push(register({ name: f.name, subject: f.id, flight: f.id, fn, p }));
      }
    }
    state.passes.sort((a, b) => a.p.start - b.p.start);
  }
}

function flightPasses(id) {
  const track = state.tracks.get(id);
  if (!track || !state.loc) return [];
  const f = state.flights.find((x) => x.id === id);
  const t0 = state.flightId === id ? state.flightT0 : track.t0;
  const fn = track.fnFor(t0);
  return findPasses(fn, state.loc.lat, state.loc.lon, t0, t0 + track.endS, passOpts())
    .map((p) => register({ name: f.name, subject: f.id, flight: f.id, fn, p }));
}

function satPasses(sat) {
  if (!state.loc) return [];
  const t = now();
  return findPasses(sat.fn, state.loc.lat, state.loc.lon, t, t + 2 * 86400, passOpts())
    .map((p) => register({ name: sat.shortName || sat.name, subject: String(sat.norad), sat, fn: sat.fn, p }));
}

const reasonText = (p) => (p.reason === "daylight" ? "Daylight" : "In Earth's Shadow");

function describe(p) {
  if (!p.visible) {
    return `Rises in the ${compass(p.azStart)} at ${hm(p.start)}, reaches ${Math.round(p.maxEl)}° and sets in the `
      + `${compass(p.azEnd)} at ${hm(p.end)}. It's ${p.reason === "daylight" ? "daylight" : "in Earth's shadow"}, so you won't see it.`;
  }
  let text = `Look ${compass(p.visAzStart)} at ${hm(p.visStart)}. `;
  text += p.visStart <= p.peak && p.peak <= p.visEnd
    ? `It climbs to ${Math.round(p.visMaxEl)}° in the ${compass(p.azPeak)} at ${hm(p.peak)}, `
    : `It gets up to ${Math.round(p.visMaxEl)}°, `;
  text += p.visEnd < p.end - 20
    ? `then fades into Earth's shadow in the ${compass(p.visAzEnd)} at ${hm(p.visEnd)}.`
    : `then sets in the ${compass(p.visAzEnd)} at ${hm(p.visEnd)}.`;
  return text;
}

function daysFromToday(t) {
  const d = new Date(t * 1000), today = new Date();
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate())
    - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
}

const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function dayWord(t) {
  const diff = daysFromToday(t);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (Math.abs(diff) < 7) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(t * 1000));
  return DATE.format(new Date(t * 1000));
}

// Launch Library 2 often knows only the day or month; never show a made-up time.
const EXACT = new Set(["", "Second", "Minute", "Hour"]);
const isExact = (l) => EXACT.has(l.net_precision || "");
function launchWhen(l, t) {
  const net = Date.parse(l.net) / 1000;
  if (LAUNCHED.has(l.status)) return { strong: statusWord(l), caption: dayWord(net) };
  if (isExact(l)) return { strong: shortCountdown(net, t), caption: `${dayWord(net)} ${hm(net)}`, countdown: net };
  if (["Day", "Morning", "Afternoon"].includes(l.net_precision)) {
    const days = daysFromToday(net);
    return { strong: days <= 1 ? dayWord(net) : `in ${days} days`, caption: DATE.format(new Date(net * 1000)) };
  }
  return { strong: MONTH.format(new Date(net * 1000)).split(" ")[0], caption: "Date not set" };
}
const siteName = (l) => (l.pad.location || l.pad.name).split(",")[0];

function passCell(entry) {
  const { p } = entry;
  const t = p.visStart ?? p.start;
  const live = now() >= p.start && now() <= p.end;
  const from = compass(p.visible ? p.visAzStart : p.azStart), to = compass(p.visible ? p.visAzEnd : p.azEnd);
  const peak = Math.round(p.visible ? p.visMaxEl : p.maxEl);
  const tp = timeParts(t);
  return `<button class="cell" data-nav="pass" data-key="${entry.key}">
    <span class="time-block${live ? " now" : ""}"><b>${live ? "Now" : `${tp.time}<small>${tp.period}</small>`}</b><span>${dayWord(t)}</span></span>
    <span class="cell-main">
      <span class="cell-title">${entry.flight ? `<span class="rocket-mark">${icons.rocket}</span>` : ""}${esc(entry.name)}</span>
      <span class="cell-sub">${from} to ${to}${p.visible ? "" : ` · ${reasonText(p)}`}</span>
    </span>
    <span class="cell-trail"><strong>${peak}°</strong>peak</span>
    <span class="chev">${icons.chevronRight}</span>
  </button>`;
}

function icsEvent(entry) {
  const { p } = entry;
  return {
    uid: `${entry.subject}-${Math.round(p.visStart ?? p.start)}@orbital`,
    start: p.visStart ?? p.start, end: p.visEnd ?? p.end,
    title: `${entry.name} pass, up to ${Math.round(p.visMaxEl ?? p.maxEl)}°`,
    description: describe(p), alarmMinutes: state.cfg.alerts.lead_minutes,
  };
}

// Navigation -----------------------------------------------------------------

const stack = () => state.stacks[state.tab];
const top = () => stack()[stack().length - 1];

function showTab(id) {
  const current = top();
  if (current) current.scroll = body().scrollTop;
  state.tab = id;
  store.set("tab", id);
  const i = TABS.findIndex((t) => t.id === id);
  $(".segmented .thumb").style.setProperty("--i", i);
  for (const b of $$("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === id));
  render({ restore: true });
}

function push(entry) {
  top().scroll = body().scrollTop;
  stack().push(entry);
  render({ focus: true });
  if (compact.matches && sheet.detent === "small") sheet.set("medium");
}

function pop() {
  if (stack().length > 1) stack().pop();
  render({ restore: true, focus: true });
}

function titleOf(entry) {
  switch (entry.v) {
    case "pass": return state.entries.get(entry.key)?.name || "Pass";
    case "launch": return missionName(state.launches.find((l) => l.id === entry.id)) || "Launch";
    case "flight": return state.flights.find((f) => f.id === entry.id)?.name.replace(/^Starship /, "") || "Flight";
    case "sat": return state.byNorad.get(entry.norad)?.shortName || "Satellite";
    case "about": return "About";
    default: return TABS.find((t) => t.id === entry.v)?.label || "";
  }
}

function navBar() {
  const s = stack();
  if (s.length < 2) return "";
  return `<div class="nav-bar"><button class="back-btn" data-act="back">${icons.chevronLeft}<span>${esc(titleOf(s[s.length - 2]))}</span></button></div>`;
}

const VIEWS = { sky: viewSky, pass: viewPass, launches: viewLaunches, launch: viewLaunch, flights: viewFlights,
  flight: viewFlight, digest: viewDigest, alerts: viewAlerts, about: viewAbout, sat: viewSat };

function render({ restore = false, focus = false } = {}) {
  const entry = top();
  body().innerHTML = `<div class="view">${navBar()}${VIEWS[entry.v](entry)}</div>`;
  body().scrollTop = restore ? entry.scroll || 0 : 0;
  if (focus) body().querySelector(".large-title")?.focus({ preventScroll: true });
  liveUpdate();
  if (globe) updateHud();
}

// Views ----------------------------------------------------------------------

function title(text) { return `<h1 class="large-title" tabindex="-1">${esc(text)}</h1>`; }

function satFinder() {
  return `<label class="search">${icons.search}<input id="sat-find" list="sat-names" placeholder="Find a Satellite" autocomplete="off" aria-label="Find a satellite by name or NORAD number"></label>`;
}

function viewSky() {
  if (!state.loc) {
    return `${title("Sky")}
      <div class="empty">
        <div class="empty-icon">${icons.moon}</div>
        <h3>What's Overhead Tonight?</h3>
        <p>Choose where you are to see when the ISS, Tiangong and flights like Starship pass over you, and whether you'll be able to see them.</p>
        <button class="btn btn-primary" data-act="geo">${icons.location}Use Current Location</button>
        <button class="btn" data-act="choose-location">Choose a City</button>
      </div>
      <h2 class="section-head">Satellites</h2>${satFinder()}`;
  }
  const t = now();
  const upcoming = state.passes.filter((x) => x.p.end > t);
  const visible = upcoming.filter((x) => x.p.visible);
  const hidden = upcoming.filter((x) => !x.p.visible);
  return `${title("Sky")}
    <p class="lede">Next ${PASS_DAYS} days over ${esc(state.loc.name)} · <button data-act="choose-location">Change</button></p>
    <h2 class="section-head">Visible Passes</h2>
    ${visible.length ? `<div class="group lead">${visible.map(passCell).join("")}</div>`
      : `<div class="group"><div class="cell"><div class="cell-main"><div class="cell-title plain">Nothing bright enough in the next ${PASS_DAYS} days</div>
         <div class="cell-sub wrap">Satellites show up around dusk and dawn, when your sky is dark and they're still in sunlight.</div></div></div></div>`}
    <div class="group" style="margin-top:10px">
      <label class="cell"><span class="cell-main"><span class="cell-title plain">Show Passes You Can't See</span></span>
        <span class="switch"><input type="checkbox" id="show-all" ${state.showAll ? "checked" : ""}><span></span></span></label>
    </div>
    ${state.showAll && hidden.length ? `<h2 class="section-head">Not Visible</h2><div class="group lead">${hidden.map(passCell).join("")}</div>` : ""}
    ${visible.length ? `<div class="group" style="margin-top:10px"><button class="cell cell-action" data-act="ics-all">
      <span class="cell-icon">${icons.calendar}</span><span class="cell-main"><span class="cell-title">Add Visible Passes to Calendar</span></span></button></div>` : ""}
    <h2 class="section-head">Satellites</h2>${satFinder()}`;
}

function viewPass({ key }) {
  const entry = state.entries.get(key);
  if (!entry || !state.loc) return `${title("Pass")}<p class="lede">This pass is no longer available.</p>`;
  const { p, fn } = entry;
  const vis = p.visible;
  const s = vis ? p.visStart : p.start, e = vis ? p.visEnd : p.end;
  const path = passPath(fn, state.loc.lat, state.loc.lon, p, 5, { darkSunEl: state.cfg.alerts.dark_sun_deg });
  const at = (t) => path.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), path[0]);
  const marks = path.length ? [
    { ...at(s), label: hm(s), kind: "start" },
    { ...at(p.peak), label: `${Math.round(at(p.peak).el)}°`, kind: "peak" },
    { ...at(e), label: hm(e), kind: "end" },
  ] : [];
  const fades = vis && p.visEnd < p.end - 20;
  return `${title(entry.name)}
    <p class="lede">${dayHm(s)} – ${hm(e)} · ${duration(e - s)}</p>
    ${vis ? `<span class="pill vis"><span class="dot"></span>Visible from ${esc(state.loc.name)}</span>` : `<span class="pill">${reasonText(p)}</span>`}
    <div class="sky-wrap">${skyChartSvg(path, marks)}</div>
    <p class="how">${esc(describe(p))}</p>
    <div class="btn-row">
      <button class="btn btn-primary" data-act="watch" data-key="${key}">${icons.globe}Show on Globe</button>
      ${vis ? `<button class="btn" data-act="ics" data-key="${key}">${icons.calendar}Add to Calendar</button>` : ""}
    </div>
    <h2 class="section-head">Details</h2>
    <div class="group">
      <div class="cell"><span class="cell-main"><span class="cell-title plain">${vis ? "Appears" : "Rises"}</span></span><span class="cell-trail">${hm(s)} · ${compass(vis ? p.visAzStart : p.azStart)}</span></div>
      <div class="cell"><span class="cell-main"><span class="cell-title plain">Highest</span></span><span class="cell-trail">${hm(p.peak)} · ${Math.round(p.maxEl)}° ${compass(p.azPeak)}</span></div>
      <div class="cell"><span class="cell-main"><span class="cell-title plain">${fades ? "Fades Into Shadow" : "Sets"}</span></span><span class="cell-trail">${hm(e)} · ${compass(vis ? p.visAzEnd : p.azEnd)}</span></div>
    </div>
    <p class="footnote">In the chart, the centre is straight overhead, the edge is the horizon and north is at the top. The green line is where you can see it.</p>`;
}

function missionName(l) {
  if (!l) return "";
  const parts = l.name.split(" | ");
  return parts.length > 1 ? parts.slice(1).join(" | ") : l.name;
}
const rocketName = (l) => l.name.split(" | ")[0] || l.rocket;

function statusPill(l) {
  if (l.status === "Success") return `<span class="pill go">Launched</span>`;
  if (l.status === "Failure" || l.status === "Partial Failure") return `<span class="pill fail">${esc(l.status)}</span>`;
  if (l.status === "In Flight") return `<span class="pill live"><span class="dot"></span>In Flight</span>`;
  if (l.status === "Go") return `<span class="pill go">Go</span>`;
  const words = { TBC: "Date Not Confirmed", TBD: "Date Not Set", Hold: "On Hold" };
  return `<span class="pill">${esc(words[l.status] || l.status)}</span>`;
}

function shortCountdown(net, t) {
  const dt = net - t;
  if (dt < 0) return countdown(net, t);
  if (dt >= 86400) return `T−${Math.floor(dt / 86400)}d ${Math.floor((dt % 86400) / 3600)}h`;
  return countdown(net, t);
}

function viewLaunches() {
  const t = now();
  const items = state.launches
    .filter((l) => state.launchFilter === "all" || l.notable)
    .filter((l) => !l.net || Date.parse(l.net) / 1000 > t - 6 * 3600);
  const seg = [["notable", "Worth Watching"], ["all", "All Launches"]].map(([v, text], i) =>
    `<button role="tab" data-filter="${v}" aria-selected="${state.launchFilter === v}">${text}</button>`).join("");
  const cells = items.map((l) => {
    const when = l.net ? launchWhen(l, t) : { strong: "TBD", caption: "" };
    const star = l.notable && state.launchFilter === "all";
    return `<button class="cell" data-nav="launch" data-id="${esc(l.id)}">
      <span class="cell-main">
        <span class="cell-title">${star ? `<span class="star-mark" aria-label="Worth watching">${icons.star}</span>` : ""}${esc(missionName(l))}</span>
        <span class="cell-sub">${esc(rocketName(l))} · ${esc(siteName(l))}</span>
      </span>
      <span class="cell-trail"><strong ${when.countdown ? `data-countdown="${when.countdown}"` : ""}>${esc(when.strong)}</strong>${esc(when.caption)}</span>
      <span class="chev">${icons.chevronRight}</span>
    </button>`;
  }).join("");
  return `${title("Launches")}
    <div class="segmented inline" role="tablist" style="--count:2;margin:6px 0 14px">
      <span class="thumb" style="--i:${state.launchFilter === "all" ? 1 : 0}"></span>${seg}</div>
    ${cells ? `<div class="group">${cells}</div>` : `<p class="lede">No launches on the books.</p>`}
    <p class="footnote">Launch schedule from Launch Library 2 by The Space Devs, in your time zone.</p>`;
}

const statusWord = (l) => ({ Success: "Launched", Failure: "Failed", "In Flight": "In Flight", "Partial Failure": "Partial" }[l.status] || l.status);

function viewLaunch({ id }) {
  const l = state.launches.find((x) => x.id === id);
  if (!l) return `${title("Launch")}<p class="lede">This launch is no longer on the schedule.</p>`;
  const net = l.net ? Date.parse(l.net) / 1000 : null;
  const flight = state.flights.find((f) => f.ll2_id === l.id);
  const ws = l.window_start && Date.parse(l.window_start) / 1000, we = l.window_end && Date.parse(l.window_end) / 1000;
  const row = (k, v) => v ? `<div class="cell"><span class="cell-main"><span class="cell-title plain">${k}</span></span><span class="cell-trail">${v}</span></div>` : "";
  return `${l.image ? `<img class="hero-img" src="${esc(l.image)}" alt="" loading="lazy">` : ""}
    ${title(missionName(l))}
    <p class="lede">${esc(rocketName(l))} · ${esc(l.provider)}</p>
    ${statusPill(l)}
    ${net && !LAUNCHED.has(l.status) && isExact(l) ? `<div class="countdown-big" data-countdown="${net}">${countdown(net, now())}</div>` : ""}
    <div class="group" style="margin-top:14px">
      ${row("Launch", !net ? "To be set" : isExact(l) ? dayHm(net) : `${launchWhen(l, now()).caption} (no exact time yet)`)}
      ${row("UTC", net && isExact(l) ? utcHm(net) : "")}
      ${ws && we && we > ws ? row("Window", `${hm(ws)} – ${hm(we)}`) : ""}
      ${row("Launch Site", esc(l.pad.location || l.pad.name))}
      ${row("Orbit", esc(l.orbit))}
      ${row("Mission", esc(l.mission_type))}
    </div>
    ${l.description ? `<p class="prose">${esc(l.description)}</p>` : ""}
    <div class="btn-row">
      ${flight ? `<button class="btn btn-primary" data-act="open-flight" data-id="${esc(flight.id)}">${icons.flights}Planned Orbit</button>` : ""}
      <button class="btn${flight ? "" : " btn-primary"}" data-act="show-pad" data-id="${esc(l.id)}">${icons.location}Launch Site</button>
    </div>`;
}

function flightStatus(f) {
  const track = state.tracks.get(f.id);
  const t = now();
  if (f.phase === "failed") return { key: "fail", text: "Ended Early" };
  const t0 = track?.t0 ?? Date.parse(f.t0) / 1000;
  if (f.t0_source !== "actual") return { key: "", text: t < t0 ? "Planned" : "Awaiting Launch" };
  if (t <= t0 + (track?.endS ?? f.met_end)) {
    const phase = track ? track.phaseAt(t - t0) : "orbit";
    return { key: "live", text: phase === "orbit" ? "In Orbit" : phase === "ascent" ? "Ascending" : "Descending" };
  }
  return { key: "go", text: "Flown" };
}

function viewFlights() {
  const cells = state.flights.map((f) => {
    const st = flightStatus(f);
    return `<button class="cell" data-nav="flight" data-id="${esc(f.id)}">
      <span class="cell-icon" style="color:var(--orange)">${icons.rocket}</span>
      <span class="cell-main"><span class="cell-title">${esc(f.name)}</span><span class="cell-sub">${esc(f.vehicle)} · ${dayHm(Date.parse(f.t0) / 1000)}</span></span>
      <span class="pill ${st.key}">${st.key === "live" ? '<span class="dot"></span>' : ""}${st.text}</span>
      <span class="chev">${icons.chevronRight}</span>
    </button>`;
  }).join("");
  return `${title("Flights")}
    <p class="lede">Flight paths modelled from the hazard areas published before launch, then placed at the real liftoff time.</p>
    ${cells ? `<div class="group icons">${cells}</div>` : `<p class="lede">No flights yet.</p>`}
    <p class="footnote">These are models, not official trajectories. Add a flight by writing a file in <code>flights/</code>.</p>`;
}

function viewFlight({ id }) {
  const track = state.tracks.get(id);
  const f = state.flights.find((x) => x.id === id);
  if (!track || !f) return `${title("Flight")}<p class="lede">Loading…</p>`;
  const d = track.data;
  const st = flightStatus(f);
  const t0p = Date.parse(d.t0_planned) / 1000;
  const winEnd = d.window_end ? Date.parse(d.window_end) / 1000 : null;
  const whatIf = d.t0_source !== "actual" && winEnd && winEnd > t0p;
  const passes = flightPasses(id);
  const inFlight = now() >= state.flightT0 && now() <= state.flightT0 + track.endS && d.t0_source === "actual";
  const when = d.t0_source === "actual" ? "Lifted off" : d.t0_source === "scheduled" ? "Scheduled for" : "Planned for";
  return `${title(f.name)}
    <span class="pill ${st.key}">${st.key === "live" ? '<span class="dot"></span>' : ""}${st.text}</span>
    <div class="mission">
      <div class="mission-clock" id="mission-clock">T+00:00:00</div>
      <div class="mission-now" id="mission-now"></div>
    </div>
    <div class="btn-row">
      ${inFlight ? `<button class="btn btn-primary" data-act="flight-live">${icons.play}Watch Live</button><button class="btn" data-act="flight-replay">${icons.back}Replay</button>`
        : `<button class="btn btn-primary" data-act="flight-replay">${icons.play}Replay Flight</button><button class="btn" data-act="flight-live">Now</button>`}
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-label">Altitude</div><div class="stat-value">${esc(d.model.altitude_km)} km</div></div>
      <div class="stat"><div class="stat-label">Inclination</div><div class="stat-value">${Number(d.model.inclination_deg).toFixed(1)}°</div></div>
      <div class="stat"><div class="stat-label">One Orbit</div><div class="stat-value">${d.model.nodal_period_min.toFixed(1)} min</div></div>
    </div>
    <p class="footnote">${when} ${dayHm(state.flightT0)} (${utcHm(state.flightT0)}) · ${duration(track.endS)} flight</p>
    <p class="prose">${esc(d.summary)}</p>
    ${whatIf ? `<div class="whatif"><div class="whatif-row"><span>If it launches at</span><b id="whatif-label">${hm(state.flightT0)}</b></div>
      <input id="whatif" type="range" min="0" max="${Math.round((winEnd - t0p) / 60)}" step="1" value="${Math.round((state.flightT0 - t0p) / 60)}" aria-label="Launch time within the window"></div>` : ""}
    <h2 class="section-head">Over ${esc(state.loc?.name || "You")}</h2>
    ${!state.loc ? `<div class="group"><button class="cell cell-action" data-act="choose-location"><span class="cell-icon">${icons.location}</span><span class="cell-main"><span class="cell-title">Choose Your Location</span></span></button></div>`
      : passes.length ? `<div class="group lead">${passes.map(passCell).join("")}</div>`
      : `<div class="group"><div class="cell"><span class="cell-main"><span class="cell-title plain">It never climbs above 10° from here.</span></span></div></div>`}
    <h2 class="section-head">Timeline</h2>
    <div class="group">${(d.events || []).map((e) => `<button class="cell" data-act="jump" data-met="${e.met}">
      <span class="met">T+${fmtMet(e.met)}</span>
      <span class="cell-main"><span class="cell-title${e.major ? "" : " plain"}">${esc(e.label)}</span></span>
      <span class="cell-trail">${hm(state.flightT0 + e.met)}</span></button>`).join("")}</div>
    ${d.source ? `<p class="footnote">${esc(d.source.text)} ${d.source.url ? `<a href="${esc(d.source.url)}" target="_blank" rel="noopener">Source</a>` : ""}</p>` : ""}`;
}

function viewSat({ norad }) {
  const sat = state.byNorad.get(norad);
  if (!sat) return `${title("Satellite")}`;
  const group = state.cfg.groups.find((g) => g.id === sat.group);
  const passes = satPasses(sat);
  const next = passes.filter((x) => x.p.visible).slice(0, 3);
  const any = passes[0];
  const age = (now() - sat.epoch) / 86400;
  return `${title(sat.shortName || sat.name)}
    <p class="lede">${esc(sat.name)} · NORAD ${sat.norad}${group ? ` · ${esc(group.label)}` : ""}</p>
    <div class="stats two" id="sat-stats"></div>
    <div class="group" style="margin-top:12px">
      <div class="cell"><span class="cell-main"><span class="cell-title plain">One Orbit</span></span><span class="cell-trail">${sat.periodMin.toFixed(1)} min</span></div>
      <div class="cell"><span class="cell-main"><span class="cell-title plain">Inclination</span></span><span class="cell-trail">${sat.inclination.toFixed(1)}°</span></div>
      <div class="cell"><span class="cell-main"><span class="cell-title plain">Orbit Data</span></span><span class="cell-trail">${age < 1 ? "Today" : `${age.toFixed(1)} days old`}</span></div>
    </div>
    ${state.loc ? `<h2 class="section-head">Next Over ${esc(state.loc.name)}</h2>
      ${next.length ? `<div class="group lead">${next.map(passCell).join("")}</div>`
        : `<div class="group"><div class="cell"><span class="cell-main"><span class="cell-title plain">No visible pass in the next 2 days</span>
           ${any ? `<span class="cell-sub wrap">It next rises ${dayWord(any.p.start).toLowerCase()} at ${hm(any.p.start)}, up to ${Math.round(any.p.maxEl)}°.</span>` : ""}</span></div></div>`}` : ""}
    <div class="btn-row"><button class="btn" data-act="deselect">${icons.close}Clear Selection</button></div>`;
}

function viewDigest() {
  const latest = state.digests[0];
  const news = state.news.slice(0, 8).map((n) => `<a class="cell" href="${esc(n.url)}" target="_blank" rel="noopener">
      <span class="cell-main"><span class="cell-title plain clamp-2">${esc(n.title)}</span>
      <span class="cell-sub">${esc(n.site)} · ${relative(Date.parse(n.published) / 1000, now())}</span></span>
      <span class="chev">${icons.external}</span></a>`).join("");
  const sub = subscribeCells(state.cfg.ntfy.weekly_topic, true);
  return `${title("Digest")}
    ${latest ? `<article class="feature">
        <div class="eyebrow">This Week</div>
        <h3>${esc(latest.title.replace(/^This week in space · /, ""))}</h3>
        <div class="cell-sub wrap">${latest.stats.launches} launches${latest.stats.notable ? `, ${latest.stats.notable} worth watching` : ""} · last week ${latest.stats.flown} flew</div>
        ${latest.highlights.length ? `<ul>${latest.highlights.map((h) => `<li><span class="star-mark">${icons.star}</span>${esc(h)}</li>`).join("")}</ul>` : ""}
        <a class="btn btn-primary" href="${esc(latest.url)}" target="_blank" rel="noopener">Read Digest</a>
      </article>
      ${state.digests.length > 1 ? `<h2 class="section-head">Earlier</h2><div class="group">${state.digests.slice(1, 8).map((d) =>
        `<a class="cell" href="${esc(d.url)}" target="_blank" rel="noopener"><span class="cell-main"><span class="cell-title plain">${esc(d.title)}</span></span><span class="chev">${icons.chevronRight}</span></a>`).join("")}</div>` : ""}`
      : `<div class="empty"><div class="empty-icon">${icons.digest}</div><h3>First Digest on Sunday</h3>
         <p>Every week: what's launching, the best passes over your city and the week's biggest stories.</p></div>`}
    <h2 class="section-head">Get It Every Sunday</h2>${sub}
    ${news ? `<h2 class="section-head">Latest News</h2><div class="group">${news}</div><p class="footnote">News from the Spaceflight News API.</p>` : ""}`;
}

function subscribeCells(topic, withFeeds = false) {
  const server = state.cfg.ntfy.server;
  return `<div class="group icons">
    <a class="cell cell-action" href="${esc(server)}/${esc(topic)}" target="_blank" rel="noopener"><span class="cell-icon">${icons.alerts}</span>
      <span class="cell-main"><span class="cell-title">Subscribe in ntfy</span></span><span class="chev">${icons.external}</span></a>
    <button class="cell" data-act="copy" data-copy="${esc(topic)}"><span class="cell-icon">${icons.copy}</span>
      <span class="cell-main"><span class="cell-title plain">Topic</span><span class="cell-sub"><code class="topic">${esc(topic)}</code></span></span>
      <span class="cell-trail">Copy</span></button>
    ${withFeeds && state.cfg.telegram.channel_url ? `<a class="cell cell-action" href="${esc(state.cfg.telegram.channel_url)}" target="_blank" rel="noopener"><span class="cell-icon">${icons.telegram}</span><span class="cell-main"><span class="cell-title">Telegram Channel</span></span><span class="chev">${icons.external}</span></a>` : ""}
    ${withFeeds ? `<a class="cell cell-action" href="digest/feed.xml"><span class="cell-icon">${icons.rss}</span><span class="cell-main"><span class="cell-title">RSS Feed</span></span><span class="chev">${icons.external}</span></a>` : ""}
  </div>`;
}

function nearestCity() {
  if (!state.loc) return null;
  let best = null;
  for (const c of state.cfg.cities) {
    const d = distanceKm(state.loc.lat, state.loc.lon, c.lat, c.lon);
    if (!best || d < best.d) best = { ...c, d };
  }
  return best;
}

function viewAlerts() {
  const a = state.cfg.alerts;
  const city = nearestCity();
  return `${title("Alerts")}
    <p class="lede">Free notifications through the ntfy app. No account or email address needed.</p>
    <h2 class="section-head">${city ? `Passes Over ${esc(city.name)}` : "Passes Over Your City"}</h2>
    ${city ? `${subscribeCells(city.topic)}
      <p class="footnote">${a.lead_minutes} minutes before the ISS or Tiangong comes into view, when it will climb above ${a.min_peak_deg}°. Starship-style flights get an alert once they're actually up.${city.d > 150 ? ` ${esc(city.name)} is ${Math.round(city.d)} km from you, so times may be a minute or two off.` : ""}</p>`
      : `<div class="group"><button class="cell cell-action" data-act="choose-location"><span class="cell-icon">${icons.location}</span><span class="cell-main"><span class="cell-title">Choose Your Location</span></span></button></div>`}
    <h2 class="section-head">Launch Reminders</h2>
    ${subscribeCells(state.cfg.ntfy.launches_topic)}
    <p class="footnote">60 and 10 minutes before launches worth watching. Reminders move when a launch slips and disappear if it's scrubbed.</p>
    <h2 class="section-head">Weekly Digest</h2>
    ${subscribeCells(state.cfg.ntfy.weekly_topic)}
    <h2 class="section-head">Calendar</h2>
    <div class="group"><button class="cell cell-action" data-act="ics-all"><span class="cell-icon">${icons.calendar}</span>
      <span class="cell-main"><span class="cell-title">Download Visible Passes</span></span></button></div>
    <h2 class="section-head">How to Subscribe</h2>
    <div class="group">
      <div class="cell"><span class="met">1</span><span class="cell-main"><span class="cell-title plain">Install the free ntfy app on your phone.</span></span></div>
      <div class="cell"><span class="met">2</span><span class="cell-main"><span class="cell-title plain">Tap Subscribe in ntfy above, or add the topic in the app.</span></span></div>
      <div class="cell"><span class="met">3</span><span class="cell-main"><span class="cell-title plain">Allow notifications. You're done.</span></span></div>
    </div>
    <div class="group" style="margin-top:22px"><button class="cell" data-nav="about"><span class="cell-icon">${icons.info}</span>
      <span class="cell-main"><span class="cell-title plain">About Orbital</span></span><span class="chev">${icons.chevronRight}</span></button></div>`;
}

function viewAbout() {
  const credit = (name, what, url) => `<a class="cell" href="${url}" target="_blank" rel="noopener"><span class="cell-main">
    <span class="cell-title plain">${name}</span><span class="cell-sub wrap">${what}</span></span><span class="chev">${icons.external}</span></a>`;
  return `${title("About Orbital")}
    <p class="lede">Know when to look up. Orbital predicts passes on your device from public orbit data, and models special flights from the hazard areas published before launch.</p>
    <h2 class="section-head">Data</h2>
    <div class="group">
      ${credit("CelesTrak", "Orbit data for satellites and space stations", "https://celestrak.org")}
      ${credit("Launch Library 2", "Launch schedule, by The Space Devs", "https://thespacedevs.com")}
      ${credit("Spaceflight News API", "News, by The Space Devs", "https://spaceflightnewsapi.net")}
      ${credit("exoplanet5", "Starship Flight 14 orbit model (MIT)", "https://github.com/exoplanet5/Starship-IFT14")}
    </div>
    <h2 class="section-head">Built With</h2>
    <div class="group">
      ${credit("CesiumJS", "3D globe (Apache 2.0)", "https://cesium.com/platform/cesiumjs/")}
      ${credit("satellite.js", "Orbit propagation (MIT)", "https://github.com/shashwatak/satellite-js")}
      ${credit("NASA Blue Marble and Black Marble", "Earth imagery (public domain)", "https://visibleearth.nasa.gov")}
      ${credit("Phosphor Icons", "Icons (MIT)", "https://phosphoricons.com")}
    </div>
    <p class="footnote">Flight paths are models, not official ephemerides. Pass times can shift by a minute when a station boosts its orbit.</p>`;
}

// Live parts, refreshed each second ------------------------------------------

function fmtMet(s) {
  s = Math.max(0, Math.floor(s));
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}

function liveUpdate() {
  const t = now();
  for (const el of $$("[data-countdown]", body())) {
    const net = Number(el.dataset.countdown);
    el.textContent = el.classList.contains("countdown-big") ? countdown(net, t) : shortCountdown(net, t);
  }
  const entry = top();
  if (entry.v === "flight") updateMission(entry.id);
  if (entry.v === "sat") updateSatStats(entry.norad);
}

function updateMission(id) {
  const track = state.tracks.get(id);
  const clock = $("#mission-clock");
  if (!track || !clock) return;
  const t = globe.time();
  const m = t - state.flightT0;
  const nowEl = $("#mission-now");
  if (m < 0) {
    clock.innerHTML = countdown(state.flightT0, t).replace(/^T−/, '<span class="unit">T−</span>');
    nowEl.textContent = "Until liftoff";
    return;
  }
  clock.innerHTML = `<span class="unit">T+</span>${fmtMet(Math.min(m, track.endS))}`;
  if (m > track.endS) { nowEl.textContent = `Landed ${dayHm(state.flightT0 + track.endS)}`; return; }
  const r = track.ecefAtMet(m);
  const g = ecefToGeodetic(r);
  const phase = { ascent: "Ascending", orbit: "In orbit", descent: "Descending" }[track.phaseAt(m)];
  nowEl.textContent = `${phase} over ${latLonText(g.lat, g.lon)} at ${Math.round(g.h)} km, ${sunlit(r, sunDirectionEcef(t)) ? "in sunlight" : "in Earth's shadow"}`;
}

function updateSatStats(norad) {
  const sat = state.byNorad.get(norad);
  const box = $("#sat-stats");
  if (!sat || !box) return;
  const t = globe.time();
  const st = sat.eci(t);
  if (!st) { box.innerHTML = `<div class="stat"><div class="stat-label">Position</div><div class="stat-value">Unavailable</div></div>`; return; }
  const r = inertialToEcef(st.r, t);
  const g = ecefToGeodetic(r);
  const stat = (k, v) => `<div class="stat"><div class="stat-label">${k}</div><div class="stat-value">${v}</div></div>`;
  box.innerHTML = stat("Altitude", `${Math.round(g.h).toLocaleString()} km`) + stat("Speed", `${Math.hypot(...st.v).toFixed(2)} km/s`)
    + stat("Over", latLonText(g.lat, g.lon)) + stat("Lighting", sunlit(r, sunDirectionEcef(t)) ? "Sunlit" : "In Shadow");
}

function capsuleInfo(t) {
  for (const f of state.flights) {
    const track = state.tracks.get(f.id);
    if (!track || f.phase === "failed" || f.t0_source !== "actual") continue;
    if (t >= track.t0 && t <= track.t0 + track.endS) {
      const phase = { ascent: "Ascending", orbit: "In Orbit", descent: "Descending" }[track.phaseAt(t - track.t0)];
      return { dot: "var(--orange)", title: f.name, sub: phase, clock: `T+${fmtMet(t - track.t0)}`, go: () => openFlight(f.id) };
    }
  }
  const next = state.launches
    .filter((l) => l.notable && l.net && !LAUNCHED.has(l.status))
    .map((l) => ({ l, net: Date.parse(l.net) / 1000 }))
    .filter((x) => x.net > t && x.net - t < 86400)
    .sort((a, b) => a.net - b.net)[0];
  if (next) {
    return { dot: "var(--orange)", title: missionName(next.l), sub: rocketName(next.l), clock: countdown(next.net, t),
      go: () => { showTab("launches"); push({ v: "launch", id: next.l.id }); } };
  }
  const pass = state.passes.find((x) => x.p.visible && x.p.visEnd > t && x.p.visStart - t < 86400);
  if (pass) {
    const p = pass.p;
    const up = t >= p.visStart;
    return { dot: "var(--green)", title: up ? `${pass.name} is up now` : pass.name,
      sub: up ? `Look ${compass(p.azPeak)}, ${Math.round(p.visMaxEl)}° high` : `Look ${compass(p.visAzStart)} at ${hm(p.visStart)}`,
      clock: up ? hm(p.visEnd) : fmtMet(p.visStart - t),
      go: () => { showTab("sky"); push({ v: "pass", key: pass.key }); } };
  }
  return null;
}

let capsuleGo = null;
function updateCapsule() {
  const info = capsuleInfo(now());
  const el = $("#capsule");
  el.hidden = !info;
  capsuleGo = info?.go || null;
  if (!info) return;
  el.style.setProperty("--dot", info.dot);
  el.querySelector(".capsule-title").textContent = info.title;
  el.querySelector(".capsule-sub").textContent = info.sub;
  el.querySelector(".capsule-clock").textContent = info.clock;
  el.setAttribute("aria-label", `${info.title}, ${info.sub}, ${info.clock}`);
}

function hudRange() {
  const track = state.tracks.get(state.flightId);
  if (top().v === "flight" && track) return [state.flightT0 - 600, state.flightT0 + track.endS + 600];
  const t = now();
  return [t - 6 * 3600, t + 42 * 3600];
}

function updateHud() {
  const show = !globe.live || state.hudOpen || top().v === "flight";
  $("#hud").hidden = !show;
  $("#btn-time").setAttribute("aria-pressed", String(show));
  if (!show) return;
  const t = globe.time();
  const [a, b] = hudRange();
  if (!state.scrubbing) $("#hud-scrub").value = String(Math.round(((t - a) / (b - a)) * 1000));
  $("#hud-time").innerHTML = `<span>${day(t)} </span><b>${hms(t)}</b>`;
  const live = globe.live && globe.playing;
  $("#hud-live").classList.toggle("on", live);
  $("#hud-live").textContent = live ? "Live" : "Go Live";
  $("#hud-play").innerHTML = globe.playing ? icons.pause : icons.play;
  $("#hud-play").setAttribute("aria-label", globe.playing ? "Pause" : "Play");
  $("#hud-speed").value = String(globe.speed);
}

function tick() {
  updateCapsule();
  updateHud();
  liveUpdate();
}

function onGlobeUpdate() {
  if (!globe.live) {
    updateHud();
    const entry = top();
    if (entry.v === "flight") updateMission(entry.id);
  }
}

// Actions --------------------------------------------------------------------

async function openFlight(id) {
  const track = await loadTrack(id);
  const f = state.flights.find((x) => x.id === id);
  state.flightId = id;
  state.flightT0 = track.t0;
  globe.showFlight(track, track.t0, f.name.replace(/^Starship /, ""));
  if (state.tab !== "flights") showTab("flights");
  if (top().v !== "flight" || top().id !== id) push({ v: "flight", id });
  else render();
  const t = now();
  const here = track.ecefAtMet(t - track.t0);
  if (here && f.t0_source === "actual") {
    globe.setLive();
    const g = ecefToGeodetic(here);
    globe.flyTo(g.lat, g.lon, 15_000_000);
  } else {
    globe.setTime(track.t0 - 30, 60);
    globe.flyTo(track.data.pad.lat, track.data.pad.lon, 15_000_000);
  }
}

function selectSat(sat) {
  state.selected = sat || null;
  globe.select(state.selected);
  if (sat && !(top().v === "sat" && top().norad === sat.norad)) push({ v: "sat", norad: sat.norad });
}

function watchPass(entry) {
  if (entry.sat) { state.selected = entry.sat; globe.select(entry.sat); }
  if (entry.flight && state.flightId !== entry.flight) {
    const track = state.tracks.get(entry.flight);
    state.flightId = entry.flight;
    state.flightT0 = track.t0;
    globe.showFlight(track, track.t0, state.flights.find((f) => f.id === entry.flight).name.replace(/^Starship /, ""));
  }
  globe.setTime((entry.p.visStart ?? entry.p.start) - 90, 10);
  globe.flyTo(state.loc.lat, state.loc.lon, 7_000_000);
  if (compact.matches) sheet.set("small");
  updateHud();
}

function setLocation(loc, { fly = true } = {}) {
  state.loc = loc;
  store.set("location", loc);
  globe.setObserver(loc);
  if (fly) globe.flyTo(loc.lat, loc.lon);
  computePasses();
  render({ restore: true });
}

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 1800);
}

function geolocate() {
  if (!navigator.geolocation) return toast("Location isn't available in this browser");
  $("#loc-error").textContent = "";
  navigator.geolocation.getCurrentPosition((pos) => {
    $("#dlg-loc").close();
    setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: "My Location" });
  }, (err) => {
    const text = err.code === 1 ? "Location access is off. Choose a city instead." : "Couldn't find your location. Choose a city instead.";
    if ($("#dlg-loc").open) $("#loc-error").textContent = text;
    else toast(text);
  }, { timeout: 10000, maximumAge: 600000 });
}

function openLocation() {
  const current = state.loc?.name;
  $("#loc-cities").innerHTML = state.cfg.cities.map((c) => `<button class="cell" type="button" data-city="${esc(c.id)}">
    <span class="cell-main"><span class="cell-title plain">${esc(c.name)}</span></span>
    ${c.name === current ? `<span class="check">${icons.check}</span>` : ""}</button>`).join("");
  $("#loc-lat").value = state.loc?.lat?.toFixed(4) ?? "";
  $("#loc-lon").value = state.loc?.lon?.toFixed(4) ?? "";
  $("#loc-name").value = "";
  $("#loc-error").textContent = "";
  $("#dlg-loc").showModal();
}

let detentBeforeLayers = null;
function toggleLayers(open) {
  if (open) renderLayers();
  $("#layers").hidden = !open;
  $("#btn-layers").setAttribute("aria-expanded", String(open));
  // On phones the sheet steps down so the layer switches have room, then comes back.
  if (!compact.matches) return;
  if (open) {
    detentBeforeLayers = sheet.detent;
    sheet.set("small");
  } else if (detentBeforeLayers) {
    sheet.set(detentBeforeLayers);
    detentBeforeLayers = null;
  }
}

function renderLayers() {
  $("#layers").innerHTML = `<h3>On the Globe</h3><div class="group">${state.cfg.groups.map((g) => `<label class="cell">
    <span class="cell-main"><span class="cell-title plain">${esc(g.label)}</span></span>
    <span class="switch"><input type="checkbox" data-group="${esc(g.id)}" ${globe.groupVisible[g.id] ? "checked" : ""}><span></span></span></label>`).join("")}</div>`;
}

// Deep links from notifications ------------------------------------------------

async function applyHash() {
  const params = Object.fromEntries(location.hash.slice(1).split("&").filter(Boolean)
    .map((kv) => kv.split("=").map(decodeURIComponent)));
  if (!Object.keys(params).length) return;
  if (params.city) {
    const c = state.cfg.cities.find((x) => x.id === params.city);
    if (c) setLocation({ lat: c.lat, lon: c.lon, name: c.name }, { fly: false });
  } else if (params.loc) {
    const [lat, lon] = params.loc.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) setLocation({ lat, lon, name: latLonText(lat, lon) }, { fly: false });
  }
  const near = (list, t) => list.find((x) => Math.abs((x.p.visStart ?? x.p.start) - Number(t)) < 600);
  const flightId = params.flight || (["flight", "headsup", "liftoff", "flightend"].includes(params.k) ? params.o : null);
  if (flightId && state.flights.some((f) => f.id === flightId)) {
    await openFlight(flightId);
    const hit = params.k === "flight" && near(flightPasses(flightId), params.t);
    if (hit) push({ v: "pass", key: hit.key });
  } else if (params.k === "pass" && params.o) {
    showTab("sky");
    const hit = near(state.passes.filter((x) => x.subject === params.o), params.t);
    if (hit) push({ v: "pass", key: hit.key });
  } else if (params.launch) {
    state.launchFilter = "all";
    showTab("launches");
    push({ v: "launch", id: params.launch });
    const l = state.launches.find((x) => x.id === params.launch);
    if (l) globe.showPad(l);
  }
  if (state.loc && !flightId) globe.flyTo(state.loc.lat, state.loc.lon);
}

// Events -----------------------------------------------------------------------

function onPick(target) {
  if (state.picking && target.kind === "globe") {
    state.picking = false;
    document.body.classList.remove("picking");
    setLocation({ lat: target.lat, lon: target.lon, name: latLonText(target.lat, target.lon) }, { fly: false });
    return toast("Location set");
  }
  if (target.kind === "sat") selectSat(state.byNorad.get(target.norad));
}

function bindEvents() {
  document.addEventListener("click", (e) => {
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) return showTab(tab.dataset.tab);
    const nav = t.closest("[data-nav]");
    if (nav) {
      const v = nav.dataset.nav;
      if (v === "flight") return openFlight(nav.dataset.id);
      return push({ v, key: nav.dataset.key, id: nav.dataset.id });
    }
    const act = t.closest("[data-act]");
    if (act) return action(act.dataset.act, act);
    const filter = t.closest("[data-filter]");
    if (filter) {
      state.launchFilter = filter.dataset.filter;
      store.set("launchFilter", state.launchFilter);
      return render({ restore: true });
    }
    const city = t.closest("[data-city]");
    if (city) {
      const c = state.cfg.cities.find((x) => x.id === city.dataset.city);
      $("#dlg-loc").close();
      return setLocation({ lat: c.lat, lon: c.lon, name: c.name });
    }
    if (!t.closest("#layers, #btn-layers") && !$("#layers").hidden) toggleLayers(false);
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "show-all") { state.showAll = t.checked; render({ restore: true }); }
    if (t.dataset.group) globe.setGroupVisible(t.dataset.group, t.checked);
    if (t.id === "sat-find") {
      const text = t.value.trim();
      const norad = Number((text.match(/(\d+)\s*$/) || [])[1]);
      const sat = state.byNorad.get(norad) || state.sats.find((s) => s.name.toLowerCase().includes(text.toLowerCase()));
      if (sat && text) { t.value = ""; selectSat(sat); globe.refresh(); }
    }
  });

  document.addEventListener("input", (e) => {
    if (e.target.id !== "whatif") return;
    const track = state.tracks.get(state.flightId);
    state.flightT0 = Date.parse(track.data.t0_planned) / 1000 + Number(e.target.value) * 60;
    globe.setFlightT0(state.flightT0);
    $("#whatif-label").textContent = hm(state.flightT0);
    clearTimeout(state.whatIfTimer);
    state.whatIfTimer = setTimeout(() => render({ restore: true }), 180);
  });

  $("#capsule").addEventListener("click", () => capsuleGo?.());
  $("#btn-locate").addEventListener("click", () => (state.loc ? globe.flyTo(state.loc.lat, state.loc.lon) : openLocation()));
  $("#btn-time").addEventListener("click", () => {
    state.hudOpen = !($("#hud").hidden === false);
    if (!state.hudOpen && !globe.live) globe.setLive();
    updateHud();
  });
  $("#btn-layers").addEventListener("click", () => toggleLayers($("#layers").hidden));

  $("#hud-play").addEventListener("click", () => { globe.togglePlay(); updateHud(); });
  $("#hud-live").addEventListener("click", () => { globe.setLive(); updateHud(); });
  $("#hud-back").addEventListener("click", () => { globe.setTime(globe.time() - 600); updateHud(); });
  $("#hud-speed").addEventListener("change", (e) => { globe.setSpeed(Number(e.target.value)); updateHud(); });
  const scrub = $("#hud-scrub");
  scrub.addEventListener("pointerdown", () => { state.scrubbing = true; });
  scrub.addEventListener("pointerup", () => { state.scrubbing = false; });
  scrub.addEventListener("input", () => {
    const [a, b] = hudRange();
    globe.setTime(a + (b - a) * (Number(scrub.value) / 1000), globe.speed);
    updateHud();
  });

  $("#loc-geo").addEventListener("click", geolocate);
  $("#loc-pick").addEventListener("click", () => {
    $("#dlg-loc").close();
    state.picking = true;
    document.body.classList.add("picking");
    toast("Click the globe where you are");
  });
  $("#loc-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const lat = Number($("#loc-lat").value), lon = Number($("#loc-lon").value);
    if ($("#loc-lat").value === "" || $("#loc-lon").value === "" || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      $("#loc-error").textContent = "Enter a latitude between −90 and 90, and a longitude between −180 and 180.";
      return;
    }
    $("#dlg-loc").close();
    setLocation({ lat, lon, name: $("#loc-name").value.trim() || latLonText(lat, lon) });
  });
  $("#dlg-loc").addEventListener("click", (e) => {
    if (e.target === $("#dlg-loc") || e.target.closest("[data-close]")) $("#dlg-loc").close();
  });
  window.addEventListener("hashchange", applyHash);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#layers").hidden) toggleLayers(false);
    if (e.key === "Escape" && stack().length > 1 && !$("#dlg-loc").open) pop();
  });
}

function action(name, el) {
  const entry = el.dataset.key && state.entries.get(el.dataset.key);
  const track = state.tracks.get(state.flightId);
  switch (name) {
    case "back": return pop();
    case "geo": return geolocate();
    case "choose-location": return openLocation();
    case "watch": return entry && watchPass(entry);
    case "ics": return entry && download(`${entry.subject}-pass.ics`, toIcs([icsEvent(entry)]));
    case "ics-all": {
      const vis = state.passes.filter((x) => x.p.visible && x.p.end > now());
      if (!vis.length) return toast("No visible passes to add");
      return download("orbital-passes.ics", toIcs(vis.map(icsEvent)));
    }
    case "copy":
      navigator.clipboard?.writeText(el.dataset.copy).then(() => toast("Topic copied"), () => toast(el.dataset.copy));
      return;
    case "deselect": state.selected = null; globe.select(null); return pop();
    case "open-flight": return openFlight(el.dataset.id);
    case "show-pad": {
      const l = state.launches.find((x) => x.id === el.dataset.id);
      if (l) globe.showPad(l);
      if (compact.matches) sheet.set("small");
      return;
    }
    case "flight-live": globe.setLive(); return updateHud();
    case "flight-replay": if (track) globe.setTime(state.flightT0 - 20, 60); return updateHud();
    case "jump":
      if (track) globe.setTime(state.flightT0 + Number(el.dataset.met) - 20, 10);
      if (compact.matches) sheet.set("small");
      return updateHud();
    default: return undefined;
  }
}

main().catch((err) => {
  console.error(err);
  fatal(`Something went wrong: ${esc(err.message)}`);
});
