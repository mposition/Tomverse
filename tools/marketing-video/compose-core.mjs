// The canvas work behind compose.mjs, in a local Chromium page (Playwright,
// which the tool already uses). Nothing is fetched but the pictures named
// here and the product fonts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { textsFor } from "./review-core.mjs";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
export const ICON_DIR = path.resolve(toolDir, "..", "..", "public", "model-icons");

const dataUrl = (file) => {
  const bytes = readFileSync(file);
  const type = bytes[0] === 0xff ? "image/jpeg" : bytes[0] === 0x52 ? "image/webp" : "image/png";
  return `data:${type};base64,${bytes.toString("base64")}`;
};

async function withPage(run) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.route("**/*", (route) => {
      const url = route.request().url();
      const ok = url.startsWith("data:") || url === "about:blank" || url.startsWith("https://fonts.googleapis.com/") || url.startsWith("https://fonts.gstatic.com/");
      return ok ? route.continue() : route.abort();
    });
    return await run(page);
  } finally {
    await browser.close();
  }
}

/** Paints the flat marks of `review.logoBoxes` with their real files. Returns how many were painted. */
export async function setLogos({ input, review, out }) {
  const marks = review.logoBoxes.filter((box) => box.flat);
  const logos = Object.fromEntries(
    [...new Set(marks.map((box) => box.logo))].map((logo) => {
      const file = path.join(ICON_DIR, `${logo}.png`);
      if (!/^[a-z0-9-]+$/u.test(logo) || !existsSync(file)) throw new Error(`no logo file for ${logo}`);
      return [logo, dataUrl(file)];
    }),
  );
  const png = await withPage((page) =>
    page.evaluate(
      async ([base, marksIn, logoUrls]) => {
        const load = async (src) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          return img;
        };
        const picture = await load(base);
        const W = picture.naturalWidth;
        const H = picture.naturalHeight;
        const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(picture, 0, 0);
        for (const box of marksIn) {
          const s = box.size * W;
          const cx = box.cx * W;
          const cy = box.cy * H;
          // The surface colour: just right of the mark, where the label or chip continues.
          const sx = Math.max(0, Math.min(W - 2, Math.round(cx + s * 0.62)));
          const sy = Math.max(0, Math.min(H - 2, Math.round(cy - s * 0.1)));
          const sw = Math.max(2, Math.min(W - sx, Math.round(s * 0.18)));
          const sh = Math.max(2, Math.min(H - sy, Math.round(s * 0.2)));
          const px = ctx.getImageData(sx, sy, sw, sh).data;
          let r = 0;
          let g = 0;
          let b = 0;
          for (let i = 0; i < px.length; i += 4) {
            r += px[i];
            g += px[i + 1];
            b += px[i + 2];
          }
          const n = px.length / 4;
          const surface = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate((box.rotate * Math.PI) / 180);
          // A soft cover a little larger than the mark, so the drawn mark is gone at its edges.
          ctx.filter = `blur(${Math.max(1, s * 0.06)}px)`;
          ctx.fillStyle = surface;
          ctx.fillRect(-s * 0.62, -s * 0.62, s * 1.24, s * 1.24);
          ctx.filter = "none";
          ctx.globalCompositeOperation = "multiply";
          ctx.drawImage(await load(logoUrls[box.logo]), -s / 2, -s / 2, s, s);
          ctx.restore();
        }
        return canvas.toDataURL("image/png");
      },
      [dataUrl(input), marks, logos],
    ),
  );
  writeFileSync(out, Buffer.from(png.split(",")[1], "base64"));
  return marks.length;
}

/** Whether the bottom of the picture, where the band goes (the last 17 %), is dark. */
export async function bottomIsDark(input) {
  return withPage((page) =>
    page.evaluate(async (base) => {
      const img = new Image();
      img.src = base;
      await img.decode();
      const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 80 });
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, 64, 80);
      const px = ctx.getImageData(0, 66, 64, 14).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      return sum / (px.length / 4) < 0.45;
    }, dataUrl(input)),
  );
}

const FONT_FAMILY = {
  en: "'Geist', sans-serif",
  ko: "'Geist', 'Noto Sans KR', sans-serif",
  "zh-Hant": "'Geist', 'Noto Sans TC', sans-serif",
  "zh-Hans": "'Geist', 'Noto Sans SC', sans-serif",
};

/** Dark or light words for a box, from the colour behind them. */
const inkFor = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#18181b" : "#ffffff";
};
const escapeHtml = (text) => text.replace(/[&<>"']/gu, (ch) => `&#${ch.charCodeAt(0)};`);

/** Sets the locale's approved words in the boxes of `roles`. Returns how many boxes were set. */
/**
 * Where a line may break. Never inside a word: a word that does not fit makes
 * the type smaller instead (the first box run, 2026-11-10, broke "Gemini Flash"
 * as "Gemin / i Flash" and "일주일" as "일 / 주일", and every language version
 * failed its content review). Korean breaks only at spaces; Chinese may break
 * between Han characters, and its Latin words (model names) stay whole.
 */
export function textBreakCss(locale) {
  return `word-break: ${locale.startsWith("zh") ? "normal" : "keep-all"}; overflow-wrap: normal;`;
}

export async function setTexts({ input, review, concept, locale, roles, out }) {
  if (!FONT_FAMILY[locale]) throw new Error(`no fonts for ${locale}`);
  const texts = textsFor(concept, locale);
  const boxes = review.textBoxes.filter((box) => roles.includes(box.role));
  const size = await withPage(async (page) => {
    await page.setContent(`<img id="probe" src="${dataUrl(input)}">`);
    return page.evaluate(async () => {
      const img = document.getElementById("probe");
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    });
  });
  const items = boxes
    .map((box, index) => {
      const words = texts[box.textIndex].text;
      const cta = box.role === "cta";
      const screen = box.role === "screen";
      // The non-English call to action is a pale guide band, never a solid button (design guide 17).
      const fill = cta ? "#eff6ff" : screen ? box.bg : "transparent";
      const ink = cta ? "#155dfb" : inkFor(box.bg);
      const weight = box.role === "headline" ? 700 : cta ? 600 : 500;
      return `<div class="box" data-i="${index}" style="left:${box.x * size.width}px;top:${box.y * size.height}px;width:${box.w * size.width}px;height:${box.h * size.height}px;transform:rotate(${box.rotate}deg);background:${fill};color:${ink};font-weight:${weight};${cta ? "border-radius:999px;" : ""}${screen ? `box-shadow:0 0 ${Math.round(size.width * 0.004)}px ${Math.round(size.width * 0.003)}px ${box.bg};` : ""}"><span>${escapeHtml(words)}</span></div>`;
    })
    .join("");
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;700&family=Noto+Sans+TC:wght@400;500;700&family=Noto+Sans+SC:wght@400;500;700&display=block">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${size.width}px; height: ${size.height}px; overflow: hidden; }
  body { position: relative; font-family: ${FONT_FAMILY[locale]}; -webkit-font-smoothing: antialiased; }
  #bg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .box { position: absolute; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0.15em 0.4em; line-height: 1.25; ${textBreakCss(locale)} transform-origin: center; }
</style></head><body><img id="bg" src="${dataUrl(input)}">${items}</body></html>`;
  const png = await withPage(async (page) => {
    await page.setViewportSize(size);
    await page.setContent(html, { waitUntil: "networkidle", timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    // The largest size at which every box holds its words.
    const unfit = await page.evaluate(() => {
      const bad = [];
      for (const box of document.querySelectorAll(".box")) {
        let px = box.clientHeight * 0.8;
        box.style.fontSize = `${px}px`;
        while (px > 8 && (box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1)) {
          px *= 0.94;
          box.style.fontSize = `${px}px`;
        }
        if (px <= 8) bad.push(box.dataset.i);
      }
      return bad;
    });
    if (unfit.length > 0) throw new Error(`words do not fit their boxes: ${unfit.join(",")}`);
    return page.screenshot({ type: "png", fullPage: false });
  });
  writeFileSync(out, png);
  return boxes.length;
}
