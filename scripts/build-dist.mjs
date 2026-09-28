// Production build of the site into dist/: one minified JS bundle (satellite.js
// inlined) and minified CSS, plus the data, digests and assets. This is what the
// Site workflow publishes to the public site repository.
//
//   python -m orbital build && npm run dist

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const OUT = "dist";
const banner = "/*! Orbital. Includes satellite.js (MIT, (C) 2013 Shashwat Kandadai, UCSC Jack Baskin School of "
  + "Engineering) and Phosphor Icons (MIT, (c) 2023 Phosphor Icons). See THIRD_PARTY_NOTICES.md. */";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
await build({
  entryPoints: ["web/js/app.js"], outfile: `${OUT}/js/app.js`, bundle: true, minify: true, format: "esm",
  target: "es2022", alias: { "satellite.js": "./web/vendor/satellite.esm.js" }, banner: { js: banner },
  legalComments: "none", logLevel: "warning",
});
await build({ entryPoints: ["web/css/app.css"], outfile: `${OUT}/css/app.css`, minify: true, logLevel: "warning" });
for (const dir of ["assets", "data", "digest"]) {
  if (existsSync(`web/${dir}`)) cpSync(`web/${dir}`, `${OUT}/${dir}`, { recursive: true });
}
const html = readFileSync("web/index.html", "utf8").replace(/<script type="importmap">[\s\S]*?<\/script>\n?/, "");
writeFileSync(`${OUT}/index.html`, html);
cpSync("THIRD_PARTY_NOTICES.md", `${OUT}/THIRD_PARTY_NOTICES.md`);
writeFileSync(`${OUT}/README.md`, "# Orbital\n\nKnow when to look up: passes over your city, launch countdowns and "
  + "planned orbits on a 3D globe.\n\nThis repository holds the published site only.\n");
writeFileSync(`${OUT}/.nojekyll`, "");
if (!existsSync(`${OUT}/data/config.json`)) console.warn("warning: no web/data yet; run `python -m orbital build` first");
console.log(`built ${OUT}/`);
