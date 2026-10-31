// Captures a real product screen for a capture scene:
//   node capture.mjs <url> <out.png|out.webm> <portrait|landscape> [seconds]
// A .png is a still; a .webm records the page for the given seconds.
// The analytics banner is declined (the privacy-preserving choice) so it is
// not in the shot. Real captures only: AI-made pictures of the product screen
// are not allowed (docs/policy/marketing-automation.md §7.3).
import { mkdtempSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

const [url, out, orientation = "portrait", seconds = "6"] = process.argv.slice(2);
if (!url || !out || !["portrait", "landscape"].includes(orientation)) {
  console.error("usage: node capture.mjs <url> <out.png|out.webm> <portrait|landscape> [seconds]");
  process.exit(2);
}
const viewport = orientation === "portrait" ? { width: 430, height: 932 } : { width: 1440, height: 900 };
const recording = out.endsWith(".webm");
const videoDir = recording ? mkdtempSync(path.join(tmpdir(), "mv-capture-")) : null;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: recording ? 1 : 2,
  ...(videoDir ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
});
const page = await context.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
const off = page.getByRole("button", { name: /turn off/i }).first();
if (await off.isVisible().catch(() => false)) await off.click();
await page.waitForTimeout(1_500);
if (recording) {
  await page.waitForTimeout(Number(seconds) * 1_000);
} else {
  await page.screenshot({ path: out });
}
await context.close();
await browser.close();
if (videoDir) {
  const [file] = readdirSync(videoDir);
  renameSync(path.join(videoDir, file), out);
}
console.log(JSON.stringify({ captured: out, url, orientation }));
