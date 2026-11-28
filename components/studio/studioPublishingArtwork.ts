import { studioPublishingTrim, type StudioSocialFormat } from "@/lib/studioPublishing";
import { canvas as scratchCanvas, readImage, encode } from "./studioCanvas";

type Box = { x: number; y: number; w: number; h: number };
export type StudioPublishingArtwork = {
  source: string;
  logo?: string;
  width: number;
  height: number;
  placement?: StudioSocialFormat;
  /** A generated design was composed for trimming; a preset sample was not and is always shown whole. */
  generated?: boolean;
  details: string;
  locale: string;
};

function imageIn(ctx: CanvasRenderingContext2D, image: CanvasImageSource & { naturalWidth: number; naturalHeight: number }, box: Box, fit: "cover" | "contain") {
  const scale = (fit === "cover" ? Math.max : Math.min)(box.w / image.naturalWidth, box.h / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  ctx.drawImage(image, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
}

function linesFor(context: CanvasRenderingContext2D, text: string, width: number,
  words: Intl.Segmenter, glyphs: Intl.Segmenter) {
  return text.split(/\r?\n/).flatMap(paragraph => {
    if (!paragraph.trim()) return [""];
    const lines: string[] = [];
    let line = "";
    for (const { segment } of words.segment(paragraph)) {
      const candidate = (line + segment).trimStart();
      if (context.measureText(candidate.trimEnd()).width <= width) {
        line = candidate;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = "";
      for (const { segment: glyph } of glyphs.segment(segment.trimStart())) {
        if (line && context.measureText(line + glyph).width > width) {
          lines.push(line);
          line = "";
        }
        line += glyph;
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
    return lines;
  });
}

/**
 * The image model designs and typesets the whole piece, and is told what share
 * of its edges the placement trims. A generated design therefore fills the
 * canvas; nothing is shrunk into a frame or lettered a second time. Only the
 * supplied details and logo are added, along the bottom.
 */
export async function drawStudioPublishingArtwork(canvas: HTMLCanvasElement, opts: StudioPublishingArtwork) {
  const { width, height, locale, placement } = opts;
  const details = opts.details.trim();
  const fontStyle = getComputedStyle(document.documentElement);
  const baseFont = fontStyle.getPropertyValue("--font-ui").trim() || "system-ui";
  const hanFont = locale === "zh-Hant" ? "--font-noto-sans-tc" : "--font-noto-sans-sc";
  const cjkFont = /\p{Script=Hangul}/u.test(details) ? "--font-noto-sans-kr"
    : /\p{Script=Han}/u.test(details) ? hanFont : undefined;
  const cjkFamily = cjkFont ? fontStyle.getPropertyValue(cjkFont).trim() : "";
  const font = cjkFamily && !baseFont.startsWith(cjkFamily) ? cjkFamily + ", " + baseFont : baseFont;
  const [image, logo] = await Promise.all([
    readImage(opts.source),
    opts.logo ? readImage(opts.logo) : null,
    details ? document.fonts.load(`450 24px ${font}`, details).catch(() => []) : null,
  ]);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.imageSmoothingQuality = "high";
  const all: Box = { x: 0, y: 0, w: width, h: height };
  const trim = studioPublishingTrim({ width: image.naturalWidth, height: image.naturalHeight }, { width, height });
  if (trim && !(opts.generated && trim.fills)) {
    // Shown whole: a sample, or a shape too far from the placement. A soft copy of the design sits behind it, in place of blank bars.
    const soft = scratchCanvas(16, Math.max(1, Math.round(16 * height / width)));
    imageIn(soft.context, image, { x: 0, y: 0, w: soft.element.width, h: soft.element.height }, "cover");
    ctx.drawImage(soft.element, 0, 0, width, height);
    imageIn(ctx, image, all, "contain");
  } else imageIn(ctx, image, all, "cover");
  if (!details && !logo) return;

  const unit = Math.min(width, height);
  const [left, , right, bottom] = placement?.safe ?? [.065, .055, .065, .055];
  const band = unit * .2;
  const base = height * (1 - bottom);
  const top = base - band * 1.45, end = Math.min(height, base + band * .45);
  // Light artwork takes dark lettering on a pale wash, and dark artwork the reverse.
  const strip = ctx.getImageData(0, Math.round(base - band), width, Math.max(1, Math.round(band))).data;
  let sum = 0, count = 0;
  for (let i = 0; i < strip.length; i += 4 * 97) {
    sum += .2126 * strip[i] + .7152 * strip[i + 1] + .0722 * strip[i + 2];
    count++;
  }
  const light = sum / count > 150;
  const wash = (alpha: number) => `rgba(${light ? "255,252,246" : "0,0,0"},${alpha})`;
  const shade = ctx.createLinearGradient(0, top, 0, end);
  shade.addColorStop(0, wash(0));
  shade.addColorStop(.42, wash(.56));
  shade.addColorStop(.76, wash(.56));
  shade.addColorStop(1, wash(end === height ? .56 : 0));
  ctx.fillStyle = shade;
  ctx.fillRect(0, top, width, end - top);

  const x = width * left, w = width * (1 - left - right);
  const mark = logo ? band * .72 : 0;
  if (logo) {
    const box = { x: x + w - mark, y: base - mark, w: mark, h: mark };
    ctx.fillStyle = "#fffaf2";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    const pad = mark * .12;
    imageIn(ctx, logo, { x: box.x + pad, y: box.y + pad, w: mark - 2 * pad, h: mark - 2 * pad }, "contain");
  }
  if (!details) return;
  const text: Box = { x, y: base - band * .86, w: w - (logo ? mark + unit * .03 : 0), h: band * .86 };
  const words = new Intl.Segmenter(locale, { granularity: "word" });
  const glyphs = new Intl.Segmenter(locale, { granularity: "grapheme" });
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = light ? "#1d1a16" : "#fff";
  const leading = 1.29;
  let size = unit * .034;
  let lines: string[] = [];
  for (let attempt = 0; attempt < 32; attempt++) {
    ctx.font = `450 ${size}px ${font}`;
    lines = linesFor(ctx, details, text.w, words, glyphs);
    if (lines.length * size * leading <= text.h) break;
    size *= .89;
  }
  const first = text.y + text.h - lines.length * size * leading;
  for (const [index, line] of lines.entries()) {
    if (line) ctx.fillText(line, text.x, first + size + index * size * leading);
  }
}

export async function renderStudioPublishingArtwork(options: StudioPublishingArtwork) {
  const canvas = document.createElement("canvas");
  await drawStudioPublishingArtwork(canvas, options);
  return encode(canvas);
}
