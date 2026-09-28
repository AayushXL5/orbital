// Render PNG app icons from web/assets/icon.svg with headless Chrome.
//   node scripts/render-icons.mjs
// apple-touch-icon.png is full-bleed (iOS rounds it); icon-192/512 keep the corners.

import { existsSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const CHROMES = [process.env.CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
const assets = new URL("../web/assets/", import.meta.url);
const svg = readFileSync(new URL("icon.svg", assets), "utf8");
const square = svg.replace('rx="114"', 'rx="0"');

const browser = await puppeteer.launch({ executablePath: CHROMES.find((p) => existsSync(p)), headless: true });
const page = await browser.newPage();
for (const [name, size, source] of [["apple-touch-icon.png", 180, square], ["icon-192.png", 192, svg], ["icon-512.png", 512, svg]]) {
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${source.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(name, assets).pathname.replace(/^\/([A-Za-z]:)/, "$1"), omitBackground: true });
  console.log("wrote", name);
}
await browser.close();
