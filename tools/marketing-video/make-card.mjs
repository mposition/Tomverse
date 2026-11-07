// Renders one 4:5 image card (1080x1350) from a source pack and a layout the
// job designed, and writes the asset file the submission needs:
//   node make-card.mjs <job/sources/<asset-id>/pack.json> <spec.json> <out-dir>
//
// The job designs every card itself (owner 2026-11-07: "no card that only
// changes its words" -- one fixed layout over the same captures was retired).
// spec.json is {"id", "layout": "<path to an HTML fragment>", "locale"?}. The
// fragment is a <style> block and the card's elements; it names pictures as
// `capture:<name>` (in an img src or a CSS url()), and those are the pack's
// real captures and nothing else.
//
// This file checks what the job cannot be trusted to keep, and refuses the
// card otherwise:
//  - words: every piece of text on the card is one of the pack's own lines
//    (question, headline lines, callouts, ctas) or "Tomverse", "Q", "→", "≠";
//  - pictures: only the pack's captures; nothing is fetched but those files
//    and the fonts this file links; no script, no CSS generated text;
//  - colours: every colour drawn is a brand colour (any opacity);
//  - nothing cut off: every line lies wholly inside the card;
//  - not a copy: the card must not look like a card of an earlier day
//    (a difference hash of the picture, so new words on an old look fail).
//
// A Simplified Chinese card for RedNote (owner 2026-11-07) is made from a
// zh-Hant pack with `"locale": "zh-Hans"`: the layout names the pack's own
// Traditional lines, and each is drawn converted by OpenCC -- no new words.
//
// Exit codes: 0 written, 2 usage, 1 anything else.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as OpenCC from "opencc-js/t2cn";
import { chromium } from "playwright";

const [packPath, specPath, outDir] = process.argv.slice(2);
if (!packPath || !specPath || !outDir) {
  console.error("usage: node make-card.mjs <pack.json> <spec.json> <out-dir>");
  process.exit(2);
}

/** The channels a card may go to, per locale: the accounts that post in it (owner 2026-11-03, 2026-11-07). */
const CARD_CHANNELS = {
  en: ["facebook", "instagram", "linkedin", "x"],
  ko: ["facebook", "instagram", "threads"],
  "zh-Hant": ["facebook", "instagram", "threads"],
  "zh-Hans": ["rednote"],
};
/** #ffffff #18181b #155dfb #eff6ff #f7f8fa #e4e4e7, as the browser reports them. */
const BRAND_RGB = ["255,255,255", "24,24,27", "21,93,251", "239,246,255", "247,248,250", "228,228,231"];
/** Marks a card may draw besides the pack's lines. */
const MARKS = ["Tomverse", "Q", "→", "≠"];
/**
 * How many of 256 hash bits must differ from every earlier day's card. Measured
 * 2026-11-07: the retired layout with only its words changed differed by 32;
 * four cards of different composition differed from it and each other by 92-144.
 */
const MIN_HASH_DISTANCE = 64;
const LOOKBACK_DAYS = 30;

const fail = (message) => {
  console.error(JSON.stringify({ step: "make-card", error: message }));
  process.exit(1);
};

const pack = JSON.parse(readFileSync(packPath, "utf8"));
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const packDir = path.dirname(path.resolve(packPath));

const locale = spec.locale ?? pack.locale;
if (locale !== pack.locale && !(locale === "zh-Hans" && pack.locale === "zh-Hant")) {
  fail(`a ${locale} card cannot be made from a ${pack.locale} pack`);
}
if (!CARD_CHANNELS[locale]) fail(`no card channels for locale ${locale}`);
if (!/^media-[a-z0-9][a-z0-9-]{0,99}$/u.test(spec.id ?? "")) fail("spec.id is not a media asset id");
const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

// The pack's captures: `captures` ({name: {file, text}}), or the first packs'
// fixed five pictures.
const captures =
  pack.captures ??
  Object.fromEntries(
    [
      ["left", pack.captureText?.[0]],
      ["center", pack.captureText?.[1]],
      ["right", pack.captureText?.[2]],
      ["summary", pack.summaryText],
      ["logo", ""],
    ].map(([name, text]) => [name, { file: pack.images?.[name], text: text ?? "" }]),
  );
for (const [name, capture] of Object.entries(captures)) {
  if (typeof capture?.file !== "string" || !existsSync(path.join(packDir, capture.file))) fail(`missing capture ${name}`);
}

const lines = [...pack.question, ...pack.headlines.flat(), ...pack.callouts, ...pack.ctas];
const normal = (text) => text.replace(/\s+/gu, " ").trim();
const allowed = new Set([...lines, ...MARKS].map(normal));

const layoutPath = path.resolve(path.dirname(path.resolve(specPath)), spec.layout ?? "");
if (!spec.layout || !existsSync(layoutPath)) fail("spec.layout names no layout file");
const layout = readFileSync(layoutPath, "utf8");
if (/<\s*(script|iframe|object|embed|link|meta|base|frame|input|textarea|select|option|button|video|audio|canvas|use|image|foreignobject)\b|\son[a-z]+\s*=|javascript:|@import|<\s*svg[^>]*\shref|xlink:href/iu.test(layout)) {
  fail("the layout may hold only HTML, CSS and capture: pictures");
}
// Every url() and src names a capture; nothing else is fetched.
const named = [...layout.matchAll(/(?:src\s*=\s*["']|url\(\s*["']?)([^"')\s]+)/giu)].map((match) => match[1]);
const unknown = named.filter((ref) => !/^capture:[a-z0-9-]+$/u.test(ref) || !captures[ref.slice(8)]);
if (unknown.length > 0) fail(`the layout names pictures that are not the pack's captures: ${JSON.stringify(unknown)}`);
const used = [...new Set(named.map((ref) => ref.slice(8)))];
const body = layout.replace(/capture:([a-z0-9-]+)/gu, (_, name) => pathToFileURL(path.join(packDir, captures[name].file)).href);

const fonts =
  locale === "zh-Hant"
    ? "'Geist', 'Noto Sans TC', sans-serif"
    : locale === "zh-Hans"
      ? "'Geist', 'Noto Sans SC', sans-serif"
      : "'Geist', 'Noto Sans KR', sans-serif";
const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700;800;900&family=Noto+Sans+KR:wght@400;500;700;900&family=Noto+Sans+TC:wght@400;500;700;900&family=Noto+Sans+SC:wght@400;500;700;900&display=block">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1080px; height: 1350px; overflow: hidden; }
  body { position: relative; font-family: ${fonts}; color: #18181b; background: #ffffff; }
</style></head><body>
${body}
</body></html>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, `${spec.id}.html`);
writeFileSync(htmlPath, html);
const pngPath = path.join(outDir, `${spec.id}.png`);

/** The picture's 256-bit difference hash, as a 0/1 string (16 rows of 16 neighbour comparisons). */
async function differenceHash(page, file) {
  const data = readFileSync(file).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: 17, height: 16 });
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, 17, 16);
    const px = ctx.getImageData(0, 0, 17, 16).data;
    const grey = (x, y) => { const i = (y * 17 + x) * 4; return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114; };
    let bits = "";
    for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) bits += grey(x, y) > grey(x + 1, y) ? "1" : "0";
    return bits;
  }, data);
}

/** Cards that earlier days made: job/<yyyymmdd>/media-*-card*.png within the lookback, never today's. */
function earlierCards(today) {
  const jobDir = path.dirname(path.resolve(outDir));
  const cutoff = Number(new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""));
  const found = [];
  for (const day of existsSync(jobDir) ? readdirSync(jobDir) : []) {
    if (!/^\d{8}$/u.test(day) || day === today || Number(day) < cutoff) continue;
    const dir = path.join(jobDir, day);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) if (/^media-.*-card(-\d+)?\.png$/u.test(file)) found.push(path.join(dir, file));
  }
  return found;
}

let cardLines = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  const fetched = [];
  const capturesAllowed = new Set(used.map((name) => pathToFileURL(path.join(packDir, captures[name].file)).href));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    const ok =
      url === pathToFileURL(htmlPath).href ||
      capturesAllowed.has(url) ||
      url.startsWith("https://fonts.googleapis.com/") ||
      url.startsWith("https://fonts.gstatic.com/");
    if (!ok) fetched.push(url);
    return ok ? route.continue() : route.abort();
  });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle", timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  if (fetched.length > 0) fail(`the layout fetched something else: ${JSON.stringify(fetched)}`);

  const found = await page.evaluate((brand) => {
    const texts = [];
    const cut = [];
    const generated = [];
    const colours = new Set();
    // Each text node is one whole line: a line split over elements reads as
    // pieces, and a piece is not one of the pack's lines.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim() || node.parentElement.closest("style")) continue;
      texts.push(node.textContent);
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width === 0) continue;
        if (rect.left < -1 || rect.top < -1 || rect.right > 1081 || rect.bottom > 1351) cut.push(node.textContent);
      }
      // A box that clips its text sideways hides part of a line.
      const owner = node.parentElement;
      if (owner.scrollWidth > owner.clientWidth + 2 && getComputedStyle(owner).overflowX !== "visible") cut.push(node.textContent);
    }
    for (const el of [document.documentElement, ...document.querySelectorAll("body, body *")]) {
      for (const pseudo of ["::before", "::after", "::marker"]) {
        const content = getComputedStyle(el, pseudo).content;
        if (content && content !== "none" && content !== "normal" && content !== '""') generated.push(content);
      }
      const style = getComputedStyle(el);
      if (style.display === "list-item") generated.push("list-item");
      // The root's own text colour is the browser's black and draws nothing; its background does.
      const props = el === document.documentElement ? ["backgroundColor", "backgroundImage"] : ["color", "backgroundColor", "backgroundImage", "boxShadow", "textShadow", "filter"];
      if (el instanceof SVGElement) props.push("fill", "stroke");
      for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(style[`border${side}Width`]) > 0) props.push(`border${side}Color`);
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) props.push("outlineColor");
      for (const prop of props) {
        for (const m of String(style[prop]).matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/gu)) {
          if (m[4] !== undefined && Number(m[4]) === 0) continue;
          const rgb = `${m[1]},${m[2]},${m[3]}`;
          if (!brand.includes(rgb)) colours.add(`${rgb} ${el.tagName} ${prop}`);
        }
        if (/\b(?:hsla?|lab|lch|oklab|oklch|color)\(/u.test(String(style[prop]))) colours.add(String(style[prop]));
      }
    }
    return { texts, cut, generated, colours: [...colours] };
  }, BRAND_RGB);

  if (found.generated.length > 0) fail(`CSS may not draw text: ${JSON.stringify(found.generated)}`);
  const strangers = found.texts.map(normal).filter((text) => text && !allowed.has(text));
  if (strangers.length > 0) fail(`text that is not one of the pack's lines: ${JSON.stringify(strangers)}`);
  if (!found.texts.some((text) => pack.headlines.flat().map(normal).includes(normal(text)))) fail("the card shows no headline line");
  if (found.cut.length > 0) fail(`lines cut off or outside the card: ${JSON.stringify(found.cut)}`);
  if (found.colours.length > 0) fail(`colours outside the brand palette: ${JSON.stringify(found.colours)}`);

  // Draw the lines in Simplified for a zh-Hans card, after they were checked as the pack's own.
  if (locale !== pack.locale) {
    await page.evaluate(() => {
      window.__lines = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) window.__lines.push(walker.currentNode);
    });
    const originals = await page.evaluate(() => window.__lines.map((node) => node.textContent));
    await page.evaluate((converted) => window.__lines.forEach((node, i) => { node.textContent = converted[i]; }), originals.map((text) => toSimplified(text)));
    await page.evaluate(() => document.fonts.ready);
  }
  await page.screenshot({ path: pngPath, type: "png" });

  const today = path.basename(path.resolve(outDir));
  const mine = await differenceHash(page, pngPath);
  for (const earlier of earlierCards(today)) {
    const theirs = await differenceHash(page, earlier);
    let distance = 0;
    for (let i = 0; i < mine.length; i += 1) if (mine[i] !== theirs[i]) distance += 1;
    if (distance < MIN_HASH_DISTANCE) {
      fail(`looks like ${path.basename(earlier)} (hash distance ${distance} < ${MIN_HASH_DISTANCE}): change the composition and the captures, not only the words`);
    }
  }
  cardLines = found.texts.map(normal).filter((text) => !MARKS.includes(text));
} finally {
  await browser.close();
}

// Every word the card shows, for the Guard at submission: its own lines and
// the words inside the captures it used. The captures' text is what the
// pictures show, so it is never converted.
const draw = (line) => (locale === pack.locale ? line : toSimplified(line));
const transcript = [
  ...cardLines.map(draw),
  ...used.map((name) => captures[name].text).filter(Boolean),
  "Tomverse",
]
  .map((text) => text.replace(/\s*→\s*$/u, ""))
  .join(" ");
const channels = CARD_CHANNELS[locale];
const validUntil = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
// The card reuses the approved short's words and captures, so it rests on the
// same claims: a post that carries it declares them and the Guard judges them
// again at submission and at every post.
const sourceAsset = path.join(packDir, pack.videoAsset ?? "");
if (!pack.videoAsset || !existsSync(sourceAsset)) fail("the pack names no source asset file to take its claims from");
const claimIds = [...(JSON.parse(readFileSync(sourceAsset, "utf8")).asset?.claimIds ?? [])];
writeFileSync(
  path.join(outDir, `${spec.id}.asset.json`),
  JSON.stringify(
    {
      asset: {
        id: spec.id,
        provenance: "capture",
        allowedChannels: channels,
        claimIds,
        validUntil,
        disclosure: Object.fromEntries(channels.map((channel) => [channel, "none"])),
        depictsProductInterface: true,
        alt: { [locale]: draw(pack.cardAlt) },
      },
      transcript: { [locale]: transcript },
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ made: spec.id, png: pngPath, captures: used }));
