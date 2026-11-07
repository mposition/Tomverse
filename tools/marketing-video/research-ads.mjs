// Market ad research for the media job (owner 2026-11-07: research the market's
// ads, then design): reads the public Meta Ad Library -- no login, nothing
// posted -- for the advertisers in research-brands.json, saves a few of each
// one's current image ads with their text, and draws them on one contact sheet
// the job reads with its Read tool.
//   node research-ads.mjs <out-dir>
// Writes <out-dir>/<brand>/img-*.jpg, <out-dir>/ads.json and <out-dir>/sheet-<n>.png.
// Most of these advertisers run video, so a video ad is kept as one still taken
// 2 seconds in (Remotion's own ffmpeg, already installed for the renders).
// A brand that fails is skipped; the run fails only when nothing was saved.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const [outDir] = process.argv.slice(2);
if (!outDir) {
  console.error("usage: node research-ads.mjs <out-dir>");
  process.exit(2);
}
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const brands = JSON.parse(readFileSync(path.join(toolDir, "research-brands.json"), "utf8"));
const PER_BRAND = 6;

const libraryUrl = (brand) =>
  brand.pageId
    ? `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=${brand.pageId}`
    : `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=${encodeURIComponent(brand.query)}`;

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const saved = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: "en-US" });
  const page = await context.newPage();
  for (const brand of brands) {
    try {
      await page.goto(libraryUrl(brand), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(5000);
      for (let i = 0; i < 5; i += 1) {
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(1500);
      }
      const cards = await page.evaluate((advertiser) => {
        const out = [];
        const seen = new Set();
        for (const img of document.querySelectorAll("img, video")) {
          const video = img.tagName === "VIDEO";
          const src = video ? img.currentSrc || img.src || img.querySelector("source")?.src || "" : img.src;
          if (!src || (!video && img.naturalWidth < 300)) continue;
          let card = img;
          for (let k = 0; k < 20 && card; k += 1) {
            card = card.parentElement;
            if (card?.innerText?.includes("Library ID")) break;
          }
          if (!card?.innerText || (card.innerText.match(/Library ID/g) ?? []).length > 1) continue;
          const text = card.innerText;
          if (advertiser && !text.includes(`\n${advertiser}\n`)) continue;
          const key = src.split("?")[0];
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            libraryId: (text.match(/Library ID: (\d+)/) ?? [])[1] ?? "",
            started: (text.match(/Started running on ([^\n]+)/) ?? [])[1] ?? "",
            body: (text.split("Sponsored\n")[1] ?? "").slice(0, 400),
            src,
            video,
          });
        }
        return out;
      }, brand.advertiser ?? "");
      const dir = path.join(outDir, brand.name);
      mkdirSync(dir, { recursive: true });
      let n = 0;
      for (const card of cards) {
        if (n >= PER_BRAND) break;
        const response = await context.request.get(card.src, { timeout: 60_000 }).catch(() => null);
        if (!response?.ok()) continue;
        const file = path.join(dir, `img-${card.libraryId || n}.jpg`);
        if (card.video) {
          const clip = path.join(dir, "clip.mp4");
          writeFileSync(clip, await response.body());
          const still = spawnSync("npx", ["--no-install", "remotion", "ffmpeg", "-loglevel", "error", "-y", "-ss", "2", "-i", clip, "-frames:v", "1", "-q:v", "3", file],
            { cwd: toolDir, encoding: "utf8", shell: process.platform === "win32" });
          rmSync(clip, { force: true });
          if (still.status !== 0) continue;
        } else {
          writeFileSync(file, await response.body());
        }
        saved.push({ brand: brand.name, file: path.relative(outDir, file), kind: card.video ? "video still" : "image", libraryId: card.libraryId, started: card.started, body: card.body });
        n += 1;
      }
      console.log(JSON.stringify({ brand: brand.name, found: cards.length, saved: n }));
    } catch (error) {
      console.log(JSON.stringify({ brand: brand.name, error: String(error.message ?? error).slice(0, 200) }));
    }
  }
  if (saved.length === 0) {
    console.error(JSON.stringify({ step: "research-ads", error: "no ad was saved" }));
    process.exitCode = 1;
  } else {
    writeFileSync(path.join(outDir, "ads.json"), JSON.stringify(saved, null, 1));
    // Contact sheets of 12, labelled by brand, for the Read tool.
    const sheetPage = await context.newPage();
    for (let start = 0, sheet = 1; start < saved.length; start += 12, sheet += 1) {
      const tiles = saved.slice(start, start + 12).map((ad) =>
        `<figure><img src="data:image/jpeg;base64,${readFileSync(path.resolve(outDir, ad.file)).toString("base64")}"><figcaption>${ad.brand} ${ad.kind} ${ad.libraryId}</figcaption></figure>`).join("");
      await sheetPage.setViewportSize({ width: 1600, height: 1500 });
      await sheetPage.setContent(`<style>body{margin:0;background:#fff;font:600 16px sans-serif;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px}
        figure{margin:0}img{width:100%;height:440px;object-fit:contain;background:#eee}figcaption{padding:4px 0}</style>${tiles}`);
      await sheetPage.waitForTimeout(500);
      await sheetPage.screenshot({ path: path.join(outDir, `sheet-${sheet}.png`), fullPage: true });
    }
    console.log(JSON.stringify({ saved: saved.length }));
  }
} finally {
  await browser.close();
}
