// Walk every screen on several phone sizes and check the layout by measurement:
// nothing spills off screen or out of the panel, text isn't clipped without an
// ellipsis, floating controls don't collide, and tap targets meet HIG minimums.
//
//   npm run mobile           # screenshots and a report in .cache/mobile/

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = new URL("../web/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = new URL("../.cache/mobile/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".xml": "application/xml" };
const CHROMES = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
const DEVICES = [
  { name: "320-small", width: 320, height: 640 },
  { name: "360-android", width: 360, height: 780 },
  { name: "375-iphone-se", width: 375, height: 667 },
  { name: "390-iphone", width: 390, height: 844 },
  { name: "430-pro-max", width: 430, height: 932 },
  { name: "844-landscape", width: 844, height: 390 },
];
const only = process.argv[2];

const server = createServer(async (req, res) => {
  const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  const file = path.endsWith("\\") || path.endsWith("/") ? join(path, "index.html") : path;
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404).end(); return; }
  if (file.endsWith("config.json")) {
    // Preview the email sign-up even when no Buttondown username is configured.
    const cfg = JSON.parse(body);
    cfg.email = { buttondown_username: cfg.email?.buttondown_username || "orbital-preview" };
    body = JSON.stringify(cfg);
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(body);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/`;
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROMES.find((p) => existsSync(p)), headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

// Runs in the page: measure the layout and return problems.
function inspect() {
  const W = window.innerWidth, H = window.innerHeight;
  const issues = [];
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
    const text = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
  };
  const hiddenByAncestor = (el) => {
    for (let a = el; a; a = a.parentElement) if (!visible(a)) return true;
    return false;
  };
  if (document.documentElement.scrollWidth > W + 1) issues.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px > ${W}px`);
  const panelBody = document.querySelector("#panel-body");
  const pb = panelBody.getBoundingClientRect();
  const all = [...document.querySelectorAll("body *")].filter((el) =>
    !el.closest("#globe, datalist, script, style, svg *") && visible(el) && !hiddenByAncestor(el));
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const onScreen = r.bottom > 0 && r.top < H;
    if (onScreen && (r.right > W + 0.5 || r.left < -0.5)) issues.push(`off screen: ${label(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
    if (panelBody.contains(el) && el !== panelBody && (r.right > pb.right + 0.5 || r.left < pb.left - 0.5)) {
      issues.push(`spills out of the panel: ${label(el)} [${Math.round(r.left)}..${Math.round(r.right)}] panel [${Math.round(pb.left)}..${Math.round(pb.right)}]`);
    }
    const s = getComputedStyle(el);
    const clips = ["hidden", "clip"].includes(s.overflowX) || ["hidden", "clip"].includes(s.overflow);
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (clips && hasText && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== "ellipsis" && !el.classList.contains("clamp-2")) {
      issues.push(`text clipped: ${label(el)} (${el.scrollWidth} > ${el.clientWidth})`);
    }
  }
  // Floating chrome must not collide.
  const chrome = ["#capsule", ".map-controls", "#hud", "#panel", "#tabbar", "#layers", "#toast"]
    .map((sel) => document.querySelector(sel)).filter((el) => el && visible(el));
  for (let i = 0; i < chrome.length; i++) {
    for (let j = i + 1; j < chrome.length; j++) {
      const a = chrome[i].getBoundingClientRect(), b = chrome[j].getBoundingClientRect();
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      if (overlap) issues.push(`overlap: ${label(chrome[i])} / ${label(chrome[j])}`);
    }
  }
  // Tap targets (HIG: 44 pt default, 28 pt minimum on phones).
  const small = [];
  for (const el of all.filter((e) => e.matches("button, a, input, select, [role=button], label.cell"))) {
    const r = el.getBoundingClientRect();
    if (el.closest("#panel-body") && (r.bottom < pb.top || r.top > pb.bottom)) continue;
    if (el.matches("input[type=checkbox]")) continue;
    if (r.width < 28 || r.height < 28) small.push(`${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  if (small.length) issues.push(`small tap targets: ${small.join("; ")}`);
  return issues;
}

const report = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const device of DEVICES.filter((d) => !only || d.name.includes(only))) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.setViewport({ width: device.width, height: device.height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("orbital:location", JSON.stringify({ lat: 28.6139, lon: 77.209, name: "New Delhi" }));
    localStorage.setItem("orbital:tab", JSON.stringify("sky"));
  });
  await page.goto(base, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("body.ready", { timeout: 60000 });
  await wait(4000);
  const shots = [];
  const check = async (screen) => {
    await wait(650);
    const issues = await page.evaluate(inspect);
    await page.screenshot({ path: join(OUT, `${device.name}-${screen}.png`) });
    shots.push({ screen, issues });
  };
  const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; }, sel);
  const tab = (id) => page.evaluate((t) => {
    const el = [...document.querySelectorAll(`[data-tab="${t}"]`)].find((b) => b.offsetParent !== null);
    el?.click();
  }, id);
  const compact = await page.evaluate(() => matchMedia("(max-width: 899px) and (min-height: 501px)").matches);
  const sheetH = () => page.evaluate(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sheet-h"), 10));
  // Drag the grabber slowly to a y position and let go (no flick).
  const drag = async (toY) => {
    const box = await (await page.$("#grabber")).boundingBox();
    const x = box.x + box.width / 2, y0 = box.y + box.height / 2;
    await page.mouse.move(x, y0);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(x, y0 + ((toY - y0) * i) / 12); await wait(16); }
    await wait(220);
    await page.mouse.up();
    await wait(500);
  };
  const tapActiveTab = () => page.evaluate(() => document.querySelector('#tabbar [aria-selected="true"]').click());

  await check("sky");
  if (compact) {
    const sheetProblems = [];
    await drag(80); await check("sheet-top");
    const top = await sheetH();
    await drag(device.height * 0.55); await check("sheet-middle");
    const middle = await sheetH();
    if (Math.abs(middle - (device.height - 78 - device.height * 0.55)) > 40) sheetProblems.push(`sheet did not stay where it was dropped (${middle}px)`);
    await drag(device.height); await check("sheet-bottom");
    if ((await sheetH()) !== 44) sheetProblems.push(`sheet did not fold to the handle (${await sheetH()}px)`);
    await tapActiveTab(); await check("sheet-hidden");
    if ((await sheetH()) !== 0) sheetProblems.push("tapping the active tab did not hide the sheet");
    await tapActiveTab(); await wait(300);
    if ((await sheetH()) !== middle) sheetProblems.push(`tapping it again restored ${await sheetH()}px, not ${middle}px`);
    if (top < middle) sheetProblems.push("dragging up did not raise the sheet");
    shots.push({ screen: "sheet-behaviour", issues: sheetProblems });
  }
  await click('#panel-body [data-nav="pass"]'); await check("pass");
  await click('[data-act="back"]');
  await page.evaluate(() => {
    const input = document.querySelector("#sat-find");
    input.value = "ISS (ZARYA)";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await check("satellite");
  await click('[data-act="deselect"]');
  await tab("launches"); await check("launches");
  await click('#panel-body [data-nav="launch"]'); await check("launch");
  await click('[data-act="back"]');
  await click('#panel-body [data-filter="all"]'); await check("launches-all");
  await tab("flights"); await check("flights");
  await click('#panel-body [data-nav="flight"]'); await wait(1500); await check("flight");
  await tab("digest"); await check("digest");
  await page.evaluate(() => document.querySelector("[data-email-form] button")?.scrollIntoView({ block: "center" }));
  await check("digest-email");
  await tab("alerts"); await check("alerts");
  await click('#panel-body [data-nav="about"]'); await check("about");
  await click('[data-act="back"]');
  await tab("sky");
  await click('[data-act="choose-location"]'); await check("location");
  await page.evaluate(() => document.querySelector("#dlg-loc").close());
  await click("#btn-layers"); await check("layers");
  await click("#btn-layers");
  report[device.name] = { errors, screens: shots };
  const n = shots.reduce((k, s) => k + s.issues.length, 0) + errors.length;
  console.log(`${device.name}: ${shots.length} screens, ${n ? `${n} problem(s)` : "clean"}`);
  for (const s of shots) for (const i of s.issues) console.log(`  [${s.screen}] ${i}`);
  for (const e of errors) console.log(`  [error] ${e}`);
  await page.close();
}
await browser.close();
server.close();
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
const total = Object.values(report).reduce((k, d) => k + d.errors.length + d.screens.reduce((m, s) => m + s.issues.length, 0), 0);
console.log(`\n${total ? `${total} problem(s)` : "No layout problems"}; screenshots in ${OUT}`);
process.exit(total ? 1 : 0);
