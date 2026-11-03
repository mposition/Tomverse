// Renders one 4:5 image card from a source pack and writes the asset file the
// submission needs:
//   node make-card.mjs <job/sources/<asset-id>/pack.json> <spec.json> <out-dir>
// The layout is the one the owner approved on 2026-11-03 (Canva DAHZ2Rm5gVc,
// "r2b"): the real question in a pill, two headline lines, three real answer
// cards fanned out, the real analysis summary under a callout band, the logo
// and a call to action. Brand colours only (#ffffff, #18181b, #155dfb,
// #eff6ff, #f7f8fa, #e4e4e7).
//
// Every word on the card comes from the pack: spec.json picks a headline pair,
// a callout and a call to action from the lines the pack carries, which are
// the approved short's own on-screen lines. A line the pack does not carry is
// refused, so the job cannot put new words on a card.
//
// Exit codes: 0 written, 2 usage, 1 anything else (a line that does not fit,
// a missing image, a refused spec).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

const [packPath, specPath, outDir] = process.argv.slice(2);
if (!packPath || !specPath || !outDir) {
  console.error("usage: node make-card.mjs <pack.json> <spec.json> <out-dir>");
  process.exit(2);
}

/** The channels a card may go to, per locale: the accounts that post in it (owner 2026-11-03). */
const CARD_CHANNELS = {
  en: ["facebook", "instagram", "linkedin", "x"],
  ko: ["facebook", "instagram"],
  "zh-Hant": ["facebook", "instagram", "threads"],
};

const fail = (message) => {
  console.error(JSON.stringify({ step: "make-card", error: message }));
  process.exit(1);
};

const pack = JSON.parse(readFileSync(packPath, "utf8"));
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const packDir = path.dirname(path.resolve(packPath));

if (!CARD_CHANNELS[pack.locale]) fail(`no card channels for locale ${pack.locale}`);
if (!/^media-[a-z0-9][a-z0-9-]{0,99}$/u.test(spec.id ?? "")) fail("spec.id is not a media asset id");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!pack.headlines.some((pair) => same(pair, spec.headline))) fail("spec.headline is not one of the pack's lines");
if (!pack.callouts.includes(spec.callout)) fail("spec.callout is not one of the pack's lines");
if (!pack.ctas.includes(spec.cta)) fail("spec.cta is not one of the pack's lines");

const image = (name) => {
  const file = path.join(packDir, pack.images[name]);
  if (!existsSync(file)) fail(`missing image ${name}: ${file}`);
  return pathToFileURL(file).href;
};
const escape = (text) =>
  String(text).replace(/[&<>"]/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

const fonts =
  pack.locale === "zh-Hant"
    ? "'Geist', 'Noto Sans TC', sans-serif"
    : pack.locale === "ko"
      ? "'Geist', 'Noto Sans KR', sans-serif"
      : "'Geist', 'Noto Sans KR', sans-serif";

const html = `<!doctype html>
<html lang="${pack.locale}"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@500;700;800&family=Noto+Sans+KR:wght@500;700;900&family=Noto+Sans+TC:wght@500;700;900&display=block">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1080px; height: 1350px; background: #ffffff; overflow: hidden; }
  body { position: relative; font-family: ${fonts}; color: #18181b; }
  .abs { position: absolute; }
  .pill { left: 56px; top: 64px; width: 968px; height: 140px; border-radius: 70px; background: #f7f8fa; border: 2px solid #e4e4e7; }
  .q { left: 98px; top: 104px; font-size: 44px; font-weight: 800; color: #155dfb; }
  .question { left: 152px; top: 78px; width: 836px; height: 112px; display: flex; flex-direction: column; justify-content: center;
    font-size: 33px; font-weight: 700; line-height: 1.3; }
  .head { left: 60px; width: 960px; font-size: 108px; font-weight: 800; line-height: 1.08; letter-spacing: -0.02em; white-space: nowrap; overflow: hidden; }
  .h1 { top: 222px; } .h2 { top: 338px; color: #155dfb; }
  .band { left: 36px; top: 508px; width: 1008px; height: 730px; border-radius: 48px; background: #eff6ff; }
  .card { width: 400px; height: 559px; object-fit: cover; }
  .left { left: 14px; top: 505px; transform: rotate(-7deg); }
  .right { left: 666px; top: 505px; transform: rotate(7deg); }
  .center { left: 340px; top: 470px; }
  .summary { left: 250px; top: 890px; width: 760px; height: 361px; object-fit: cover; transform: rotate(-2deg); }
  .callout { left: 300px; top: 862px; width: 600px; height: 72px; border-radius: 36px; background: #155dfb; color: #ffffff;
    transform: rotate(-2deg); display: flex; align-items: center; justify-content: center; padding: 0 28px;
    font-size: 36px; font-weight: 800; white-space: nowrap; overflow: hidden; }
  .logo { left: 60px; top: 1258px; width: 56px; height: 56px; }
  .brand { left: 128px; top: 1264px; font-family: 'Geist', sans-serif; font-size: 38px; font-weight: 800; }
  .cta { right: 60px; top: 1266px; width: 600px; text-align: right; font-size: 32px; font-weight: 800; color: #155dfb; white-space: nowrap; overflow: hidden; }
</style></head><body>
  <div class="abs pill"></div>
  <div class="abs q">Q</div>
  <div class="abs question" data-fit="22">${pack.question.map((line) => `<div>${escape(line)}</div>`).join("")}</div>
  <div class="abs head h1" data-fit="64">${escape(spec.headline[0])}</div>
  <div class="abs head h2" data-fit="64">${escape(spec.headline[1])}</div>
  <div class="abs band"></div>
  <img class="abs card left" src="${image("left")}">
  <img class="abs card right" src="${image("right")}">
  <img class="abs card center" src="${image("center")}">
  <img class="abs summary" src="${image("summary")}">
  <div class="abs callout" data-fit="24">${escape(spec.callout)}</div>
  <img class="abs logo" src="${image("logo")}">
  <div class="abs brand">Tomverse</div>
  <div class="abs cta" data-fit="22">${escape(spec.cta)}</div>
</body></html>`;

mkdirSync(outDir, { recursive: true });
const htmlPath = path.join(outDir, `${spec.id}.html`);
writeFileSync(htmlPath, html);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle", timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  // Shrink each line until it fits its box; a line that cannot fit at its floor is refused.
  const overflowing = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll("[data-fit]")) {
      const floor = Number(el.dataset.fit);
      let size = parseFloat(getComputedStyle(el).fontSize);
      // A one-line box overflows only sideways (a tall glyph is not a wrap);
      // the question's two lines must also fit its height.
      const wraps = el.classList.contains("question");
      const over = () => el.scrollWidth > el.clientWidth + 1 || (wraps && el.scrollHeight > el.clientHeight + 1);
      while (over() && size > floor) {
        size -= 2;
        el.style.fontSize = `${size}px`;
      }
      if (over()) bad.push(el.textContent);
    }
    return bad;
  });
  if (overflowing.length > 0) fail(`lines do not fit: ${JSON.stringify(overflowing)}`);
  // The two headline lines share one size, the smaller of the two fitted.
  await page.evaluate(() => {
    const heads = [...document.querySelectorAll(".head")];
    const size = Math.min(...heads.map((el) => parseFloat(getComputedStyle(el).fontSize)));
    for (const el of heads) el.style.fontSize = `${size}px`;
  });
  await page.screenshot({ path: path.join(outDir, `${spec.id}.png`), type: "png" });
} finally {
  await browser.close();
}

// Every word the card shows, in reading order, for the Guard at submission --
// the captures' own text included (the answers' model names, numbers and
// wording are on the card too), so a person approving it sees the Guard's
// codes for all of it.
if (!Array.isArray(pack.captureText) || pack.captureText.length !== 3) {
  fail("pack.captureText must hold the left, center and right captures' text");
}
const transcript = [
  ...pack.question,
  ...spec.headline,
  ...pack.captureText,
  spec.callout,
  pack.summaryText,
  "Tomverse",
  spec.cta.replace(/\s*→\s*$/u, ""),
].join(" ");
const channels = CARD_CHANNELS[pack.locale];
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
        alt: { [pack.locale]: pack.cardAlt },
      },
      transcript: { [pack.locale]: transcript },
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ made: spec.id, png: path.join(outDir, `${spec.id}.png`) }));
