// Reports which font files the build actually preloads, and how large they are.
//
// Reads the prerendered HTML in `.next/server/app`, collects every
// `<link rel="preload" as="font">` href, and resolves each one against
// `.next/static/media` so the numbers come from the build output rather than
// from the font configuration's intent.
//
// Usage: node scripts/report-font-preload.mjs [--json]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const APP_DIR = join(process.cwd(), ".next", "server", "app");
const MEDIA_DIR = join(process.cwd(), ".next", "static", "media");

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

function preloadedFonts(html) {
  const hrefs = new Set();
  // Next emits the attributes in either order depending on the renderer, so
  // match the whole tag and then pull the href out of it.
  const linkRe = /<link\b[^>]*\brel="preload"[^>]*>/g;
  let match;
  while ((match = linkRe.exec(html))) {
    const tag = match[0];
    if (!/\bas="font"/.test(tag)) continue;
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (href) hrefs.add(href);
  }
  return hrefs;
}

function mediaSize(href) {
  const name = basename(href);
  try {
    return statSize(join(MEDIA_DIR, name));
  } catch {
    return 0;
  }
}

function statSize(path) {
  return statSync(path).size;
}

const pages = walk(APP_DIR).sort();
const perRoute = [];
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const fonts = [...preloadedFonts(html)];
  const bytes = fonts.reduce((total, href) => total + mediaSize(href), 0);
  perRoute.push({
    route:
      "/" +
      page
        .slice(APP_DIR.length + 1)
        .replace(/\.html$/, "")
        .replace(/(^|\/)index$/, ""),
    fonts,
    count: fonts.length,
    bytes,
  });
}

let emittedCount = 0;
let emittedBytes = 0;
try {
  for (const name of readdirSync(MEDIA_DIR)) {
    if (!/\.(woff2?|ttf|otf|eot)$/.test(name)) continue;
    emittedCount += 1;
    emittedBytes += statSize(join(MEDIA_DIR, name));
  }
} catch {
  // no media directory -- reported as zero below
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({ perRoute, emittedCount, emittedBytes }, null, 2)
  );
} else {
  console.log(`Self-hosted font files emitted: ${emittedCount} (${kb(emittedBytes)})\n`);
  console.log("Preloaded per prerendered route:");
  const worst = [...perRoute].sort((a, b) => b.bytes - a.bytes);
  for (const route of worst) {
    console.log(
      `  ${route.route.padEnd(38)} ${String(route.count).padStart(2)} file(s)  ${kb(route.bytes).padStart(10)}`
    );
  }
  const counts = new Set(perRoute.map((route) => route.count));
  console.log(
    `\nRoutes: ${perRoute.length}; distinct preload counts: ${[...counts].sort().join(", ")}`
  );
}
