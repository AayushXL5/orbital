// Smoke test: serve web/, open it in headless Chrome, fail on console errors,
// and save screenshots. Needs a local Chrome or Edge and a `build` first.
//
//   npm run smoke              # desktop + phone screenshots in .cache/smoke/
//   CHROME=/path/to/chrome npm run smoke

import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = new URL("../web/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = new URL("../.cache/smoke/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".xml": "application/xml" };
const CHROMES = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);

const server = createServer(async (req, res) => {
  const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  const file = path.endsWith("\\") || path.endsWith("/") ? join(path, "index.html") : path;
  let body;
  try {
    body = await readFile(file);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(body);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/`;
mkdirSync(OUT, { recursive: true });

const executablePath = CHROMES.find((p) => existsSync(p));
if (!executablePath) throw new Error("No Chrome or Edge found; set CHROME=/path/to/chrome");
const browser = await puppeteer.launch({ executablePath, headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-first-run"] });

const problems = [];
async function visit(name, hash, viewport, { tab, then } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${name}: console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`${name}: request failed ${r.url()} ${r.failure()?.errorText}`));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("orbital:location", JSON.stringify({ lat: 28.6139, lon: 77.209, name: "New Delhi" }));
    localStorage.setItem("orbital:tab", JSON.stringify("sky"));
  });
  await page.goto(base + hash, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector("body.ready", { timeout: 60000 }).catch(() => problems.push(`${name}: never became ready`));
  if (tab) await page.click(`[data-tab="${tab}"]:not([hidden])`).catch(() => page.evaluate((t) => document.querySelector(`#tabbar [data-tab="${t}"]`)?.click(), tab));
  await new Promise((r) => setTimeout(r, 5000));  // let imagery stream in
  if (then) await then(page);
  const summary = await page.evaluate(() => ({
    view: document.querySelector("#panel-body .large-title")?.textContent,
    rows: document.querySelectorAll("#panel-body .cell").length,
    capsule: document.querySelector("#capsule")?.hidden ? "" : document.querySelector("#capsule")?.textContent.replace(/\s+/g, " ").trim(),
    hud: !document.querySelector("#hud")?.hidden,
    fatal: document.querySelector("#fatal")?.hidden ? "" : document.querySelector("#fatal")?.textContent,
  }));
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(name, JSON.stringify(summary));
  await page.close();
}

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const openFirstPass = async (page) => {
  await page.evaluate(() => document.querySelector('#panel-body [data-nav="pass"]')?.click());
  await new Promise((r) => setTimeout(r, 1200));
};
try {
  await visit("desktop-sky", "", desktop);
  await visit("desktop-pass", "", desktop, { then: openFirstPass });
  await visit("desktop-flight", "#flight=starship-ift14", desktop);
  await visit("desktop-launches", "", desktop, { tab: "launches" });
  await visit("desktop-digest", "", desktop, { tab: "digest" });
  await visit("desktop-alerts", "", desktop, { tab: "alerts" });
  await visit("phone-sky", "", phone);
  await visit("phone-flight", "#flight=starship-ift14", phone);
} finally {
  await browser.close();
  server.close();
}
console.log(`screenshots in ${OUT}`);
if (problems.length) {
  console.error("\nProblems:\n" + problems.join("\n"));
  process.exit(1);
}
