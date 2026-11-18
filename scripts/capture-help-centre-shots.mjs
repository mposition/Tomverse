// Help Centre guide screenshots.
//
// Captures real screens from a local E2E server (`npm run build` then
// `npm run start:e2e`), as a guest, in Korean and English, dark theme, and
// writes them to public/help/shots/<lang>/<key>.webp. The rectangle each
// guide step points at is measured from the live element and written to
// lib/helpCentre/shots.json, so a moved button moves its highlight on the
// next capture instead of leaving a stale box.
//
//   CAPTURE_ORIGIN=http://127.0.0.1:3100 node --import tsx scripts/capture-help-centre-shots.mjs
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { prepareGuestPage } from "../tests/e2e/support/app-fixtures.ts";

const origin = process.env.CAPTURE_ORIGIN || "http://127.0.0.1:3100";
const languages = (process.env.CAPTURE_LANGUAGES || "ko,en").split(",");
const viewport = { width: 1440, height: 900 };

/** key -> where to go, what to open, and which element the step points at. */
const SHOTS = [
  { key: "review-composer", path: (lang) => `/review?lang=${lang}`, target: '[data-testid="chat-input"]' },
  { key: "chat-composer", path: (lang) => `/chat?lang=${lang}`, target: '[data-testid="chat-textarea"]' },
  { key: "pricing-page", path: (lang) => `/${lang}/pricing`, target: "main h1" },
];

/**
 * What the isolated server shows that a reader never would: the analytics
 * banner (no stored choice) and the "no model can search the web" warning
 * (no provider is reachable). Both are dismissed before the capture.
 */
async function tidy(page) {
  const decline = page.getByTestId("analytics-consent-decline");
  if (await decline.isVisible().catch(() => false)) await decline.click();
  // The warning's button and the mode chip's remove button share a name, so
  // take the first; either one turns the mode off.
  const webSearchOff = page.getByRole("button", { name: /웹 검색 끄기|Turn web search off|Turn off web search/i }).first();
  if (await webSearchOff.isVisible().catch(() => false)) await webSearchOff.click().catch(() => undefined);
  await page.waitForTimeout(400);
}

const hotspots = {};
const done = [];
const skipped = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const lang of languages) {
    await mkdir(`public/help/shots/${lang}`, { recursive: true });
    const context = await browser.newContext({ baseURL: origin, viewport, colorScheme: "dark", timezoneId: "UTC" });
    for (const shot of SHOTS) {
      const page = await context.newPage();
      try {
        await prepareGuestPage(page, lang);
        await page.goto(shot.path(lang), { waitUntil: "networkidle", timeout: 60_000 });
        await tidy(page);
        if (shot.open) await shot.open(page);
        const target = page.locator(shot.target).first();
        await target.waitFor({ state: "visible", timeout: 20_000 });
        const box = await target.boundingBox();
        const png = await page.screenshot({ type: "png" });
        await writeFile(`public/help/shots/${lang}/${shot.key}.webp`, await sharp(png).resize({ width: 1440 }).webp({ quality: 82 }).toBuffer());
        if (box && lang === "en") {
          const pct = (value, total) => Math.max(0, Math.min(100, Math.round((value / total) * 1000) / 10));
          hotspots[shot.key] = {
            x: pct(box.x - 6, viewport.width),
            y: pct(box.y - 6, viewport.height),
            w: pct(box.width + 12, viewport.width),
            h: pct(box.height + 12, viewport.height),
          };
        }
        done.push(`${lang}/${shot.key}`);
      } catch (error) {
        skipped.push(`${lang}/${shot.key}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
      } finally {
        await page.close();
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
}
if (Object.keys(hotspots).length) await writeFile("lib/helpCentre/shots.json", `${JSON.stringify(hotspots, null, 2)}\n`);
console.log(JSON.stringify({ done, skipped }, null, 2));
