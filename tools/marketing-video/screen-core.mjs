// The app screen on a picture's device (owner 2026-11-13: words set flat in
// boxes looked pasted on; a screen must look like a real phone screen).
//
// The concept asks the image model to draw every display that shows words as
// flat chroma green (SCREEN_GREEN). Code finds that green in the pixels, lays
// the app screen out at the display's own proportions in the product fonts,
// maps it onto the display's four corners in perspective, and keys it in only
// where the picture is green -- so a finger or a reflection drawn over the
// display stays in front, and no image model ever draws the screen's letters.
import { writeFileSync } from "node:fs";

import { dataUrl, escapeHtml, FONT_FAMILY, textBreakCss, withPage } from "./compose-core.mjs";
import { SCREEN_UI } from "./concepts-core.mjs";

/** The colour a concept asks for on every display that shows words. */
export const SCREEN_GREEN = "#00ff00";

/**
 * The CSS matrix3d that maps a w x h rectangle onto the quad `to` (four corner
 * points in pixels: top left, top right, bottom right, bottom left).
 */
export function quadMatrix(w, h, to) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = to;
  // The projective map of the unit square onto the quad (Heckbert).
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const k = (dx1 * dy3 - dx3 * dy1) / det;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + k * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + k * y3;
  // Scaled from the unit square to w x h; CSS takes the matrix column by column.
  return [a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, x0, y0, 0, 1];
}

/**
 * The quadrilateral around a convex polygon that adds the least area: the
 * hull's edges are dropped one at a time, each time the one whose neighbours,
 * extended to meet, cover the smallest triangle. A display's rounded corners
 * come out as sharp ones, which the extreme points along its diagonals do not
 * (the first prototype, 2026-11-13, skewed the screen that way).
 */
export function enclosingQuad(hull) {
  let poly = hull.slice();
  const meet = (a, b, c, d) => {
    const r = [b[0] - a[0], b[1] - a[1]];
    const s = [d[0] - c[0], d[1] - c[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
    // The meeting point lies beyond b on a->b, going forward.
    if (t < 1) return null;
    return [a[0] + t * r[0], a[1] + t * r[1]];
  };
  const area = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  while (poly.length > 4) {
    const n = poly.length;
    let best = null;
    for (let i = 0; i < n; i += 1) {
      const a = poly[(i - 1 + n) % n];
      const b = poly[i];
      const c = poly[(i + 1) % n];
      const d = poly[(i + 2) % n];
      const p = meet(a, b, d, c);
      if (!p) continue;
      const added = area(b, p, c);
      if (!best || added < best.added) best = { i, p, added };
    }
    if (!best) return null;
    const next = [];
    for (let k = 0; k < n; k += 1) {
      if (k === best.i) next.push(best.p);
      else if (k !== (best.i + 1) % n) next.push(poly[k]);
    }
    poly = next;
  }
  if (poly.length !== 4) return null;
  // Top left, top right, bottom right, bottom left.
  const bySum = [...poly].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const byDiff = [...poly].sort((a, b) => a[0] - a[1] - (b[0] - b[1]));
  return [bySum[0], byDiff[3], bySum[3], byDiff[0]];
}

/** The convex hull of points [x, y] (monotone chain), counter-clockwise in screen axes. */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The green displays of a picture, largest first: each connected region of
 * chroma green large enough to be a display, with its four corners (fractions;
 * the least-area quadrilateral around the region) and its share of the picture.
 */
export async function findGreenScreens(input) {
  const found = await withPage((page) =>
    page.evaluate(async (base) => {
      const img = new Image();
      img.src = base;
      await img.decode();
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, W, H).data;
      const green = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i += 1) green[i] = px[i * 4 + 1] - Math.max(px[i * 4], px[i * 4 + 2]) > 70 ? 1 : 0;
      const seen = new Uint8Array(W * H);
      const regions = [];
      for (let start = 0; start < W * H; start += 1) {
        if (!green[start] || seen[start]) continue;
        const stack = [start];
        seen[start] = 1;
        let size = 0;
        // Per row, the leftmost and rightmost pixel: enough for the convex hull.
        const rows = new Map();
        while (stack.length > 0) {
          const i = stack.pop();
          size += 1;
          const x = i % W;
          const y = (i - x) / W;
          const row = rows.get(y);
          if (!row) rows.set(y, [x, x]);
          else {
            if (x < row[0]) row[0] = x;
            if (x > row[1]) row[1] = x;
          }
          for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
            if (j < 0 || j >= W * H || !green[j] || seen[j]) continue;
            seen[j] = 1;
            stack.push(j);
          }
        }
        if (size >= W * H * 0.004) regions.push({ share: size / (W * H), rows: [...rows.entries()].map(([y, [a, b]]) => [y, a, b]) });
      }
      return { W, H, regions };
    }, dataUrl(input)),
  );
  const screens = [];
  for (const region of found.regions) {
    const points = region.rows.flatMap(([y, a, b]) => [[a, y], [b + 1, y], [a, y + 1], [b + 1, y + 1]]);
    const quad = enclosingQuad(convexHull(points));
    if (quad) screens.push({ share: region.share, corners: quad.map(([x, y]) => [x / found.W, y / found.H]) });
  }
  return screens.sort((a, b) => b.share - a.share);
}

/**
 * Draws the app screen on the picture's largest green display and writes the
 * picture to `out`. `items`: [{ kind, text }] in reading order. A display
 * wider than tall is a laptop's. Returns the display's corners; throws when
 * the picture has no green display or the words do not fit it.
 */
export async function setScreen({ input, items, locale, dark = false, out }) {
  if (!FONT_FAMILY[locale]) throw new Error(`no fonts for ${locale}`);
  if (!Array.isArray(items) || items.length === 0 || !items.every((item) => SCREEN_UI.includes(item.kind) && typeof item.text === "string" && item.text.trim())) {
    throw new Error("screen items are title, question, answer or caption with words");
  }
  const [display] = await findGreenScreens(input);
  if (!display) throw new Error("the picture has no green screen");
  const size = await withPage(async (page) => {
    await page.setContent(`<img id="probe" src="${dataUrl(input)}">`);
    return page.evaluate(async () => {
      const img = document.getElementById("probe");
      await img.decode();
      return { width: img.naturalWidth, height: img.naturalHeight };
    });
  });
  const corners = display.corners.map(([x, y]) => [x * size.width, y * size.height]);
  const length = ([ax, ay], [bx, by]) => Math.hypot(bx - ax, by - ay);
  // Laid out at a fixed width in the display's own proportions, so type sizes are stable.
  const across = (length(corners[0], corners[1]) + length(corners[3], corners[2])) / 2;
  const down = (length(corners[0], corners[3]) + length(corners[1], corners[2])) / 2;
  const device = across > down ? "laptop" : "phone";
  const w = device === "phone" ? 360 : 960;
  const h = Math.round((w * down) / across);
  const matrix = quadMatrix(w, h, corners);
  const theme = dark
    ? { bg: "#111214", ink: "#f4f4f5", muted: "#a1a1aa", answer: "#26272b", title: "#1c1d20" }
    : { bg: "#ffffff", ink: "#18181b", muted: "#71717a", answer: "#f0f1f3", title: "#f4f4f5" };
  const blocks = items
    .map((item) => {
      const text = escapeHtml(item.text);
      if (item.kind === "title") return `<div class="title">${text}</div>`;
      if (item.kind === "question") return `<div class="row me"><div class="bubble q">${text}</div></div>`;
      if (item.kind === "answer") return `<div class="row"><div class="bubble a">${text}</div></div>`;
      return `<div class="caption">${text}</div>`;
    })
    .join("");
  const unit = w / 100;
  const top = device === "phone" ? 15 : 5;
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;700&family=Noto+Sans+TC:wght@400;500;700&family=Noto+Sans+SC:wght@400;500;700&display=block">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${size.width}px; height: ${size.height}px; overflow: hidden; background: transparent; }
  body { position: relative; -webkit-font-smoothing: antialiased; }
  #screen { position: absolute; left: 0; top: 0; width: ${w}px; height: ${h}px; transform-origin: 0 0; transform: matrix3d(${matrix.join(",")});
    background: ${theme.bg}; font-family: ${FONT_FAMILY[locale]}; color: ${theme.ink}; overflow: hidden;
    display: flex; flex-direction: column; gap: ${unit * 3.2}px; padding: ${unit * top}px ${unit * 5}px ${unit * 6}px; ${textBreakCss(locale)} }
  /* A faint sheen across the glass, as a lit display shows in a room. */
  #screen::after { content: ""; position: absolute; inset: 0; background: linear-gradient(115deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 38%, rgba(0,0,0,0.04) 100%); }
  .title { align-self: center; font-size: ${unit * 4.4}px; font-weight: 600; padding: 0.35em 0.9em; border-radius: 999px; background: ${theme.title}; color: ${theme.muted}; }
  .row { display: flex; }
  .row.me { justify-content: flex-end; }
  .bubble { max-width: 86%; font-size: var(--type); line-height: 1.36; padding: 0.55em 0.8em; border-radius: 1.05em; }
  .q { background: #155dfb; color: #ffffff; border-bottom-right-radius: 0.3em; }
  .a { background: ${theme.answer}; border-bottom-left-radius: 0.3em; }
  .caption { font-size: ${unit * 3.8}px; color: ${theme.muted}; padding-left: 0.5em; }
</style></head><body><div id="screen" style="--type:${unit * 6.4}px">${blocks}</div></body></html>`;
  const layer = await withPage(async (page) => {
    await page.setViewportSize(size);
    await page.setContent(html, { waitUntil: "networkidle", timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    // The largest answer type at which everything fits on the display.
    const fits = await page.evaluate(() => {
      const el = document.getElementById("screen");
      let px = parseFloat(el.style.getPropertyValue("--type"));
      while (px > 8 && el.scrollHeight > el.clientHeight + 1) {
        px *= 0.95;
        el.style.setProperty("--type", `${px}px`);
      }
      return px > 8;
    });
    if (!fits) throw new Error("the screen's words do not fit the screen");
    return page.screenshot({ type: "png", fullPage: false, omitBackground: true });
  });
  // Keyed in where the picture is green; the green cast at the display's edge turned neutral.
  const png = await withPage((page) =>
    page.evaluate(
      async ([base, ui]) => {
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
        const photo = ctx.getImageData(0, 0, W, H);
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(await load(ui), 0, 0);
        const screenPx = ctx.getImageData(0, 0, W, H).data;
        const p = photo.data;
        for (let i = 0; i < W * H; i += 1) {
          const r = p[i * 4];
          const g = p[i * 4 + 1];
          const b = p[i * 4 + 2];
          const spill = g - Math.max(r, b);
          if (spill <= 12) continue;
          // 0 at a faint cast, 1 on the display itself.
          const key = Math.min(1, Math.max(0, (spill - 25) / 70));
          const ua = (screenPx[i * 4 + 3] / 255) * key;
          const neutral = Math.max(r, b) + spill * 0.15;
          p[i * 4] = r * (1 - ua) + screenPx[i * 4] * ua;
          p[i * 4 + 1] = neutral * (1 - ua) + screenPx[i * 4 + 1] * ua;
          p[i * 4 + 2] = b * (1 - ua) + screenPx[i * 4 + 2] * ua;
        }
        ctx.putImageData(photo, 0, 0);
        return canvas.toDataURL("image/png");
      },
      [dataUrl(input), `data:image/png;base64,${layer.toString("base64")}`],
    ),
  );
  writeFileSync(out, Buffer.from(png.split(",")[1], "base64"));
  return display.corners;
}
