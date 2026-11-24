import type { StudioSocialFormat } from "@/lib/studioPublishing";
import type { studioPublishingDesign } from "@/lib/studioPublishing";
import { readImage, encode } from "./studioCanvas";

type Box = { x: number; y: number; w: number; h: number };
type Design = ReturnType<typeof studioPublishingDesign>;
export type StudioPublishingArtwork = {
  source: string;
  logo?: string;
  width: number;
  height: number;
  design: Design;
  placement?: StudioSocialFormat;
  title: string;
  details: string;
  locale: string;
};

function imageIn(ctx: CanvasRenderingContext2D, image: HTMLImageElement, box: Box, fit: "cover" | "contain" = "cover", focalY = .5) {
  const scale = (fit === "cover" ? Math.max : Math.min)(box.w / image.naturalWidth, box.h / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.drawImage(image, box.x + (box.w - w) / 2, box.y + (box.h - h) * focalY, w, h);
  ctx.restore();
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

function textIn(ctx: CanvasRenderingContext2D, options: {
  text: string; box: Box; family: string; size: number; weight: number; color: string;
  leading: number; align?: "left" | "center"; bottom?: boolean; spacing?: number;
  words: Intl.Segmenter; glyphs: Intl.Segmenter;
}) {
  const { text, box, family, weight, leading, color, align = "left", bottom, spacing = 0, words, glyphs } = options;
  if (!text) return;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.letterSpacing = spacing + "px";
  let size = options.size;
  let lines: string[] = [];
  for (let attempt = 0; attempt < 32; attempt++) {
    ctx.font = `${weight} ${size}px ${family}`;
    lines = linesFor(ctx, text, box.w, words, glyphs);
    if (lines.length * size * leading <= box.h) break;
    size *= .89;
  }
  const x = align === "center" ? box.x + box.w / 2 : box.x;
  const top = bottom ? box.y + box.h - lines.length * size * leading : box.y;
  for (const [index, line] of lines.entries()) {
    if (line) ctx.fillText(line, x, top + size + index * size * leading);
  }
  ctx.restore();
}

export async function drawStudioPublishingArtwork(canvas: HTMLCanvasElement, opts: StudioPublishingArtwork) {
  const { width, height, locale, placement, design } = opts;
  const title = opts.title.trim(), details = opts.details.trim();
  const fontStyle = getComputedStyle(document.documentElement);
  const baseFont = fontStyle.getPropertyValue("--font-ui").trim() || "system-ui";
  const copy = title + " " + details;
  const hanFont = locale === "zh-Hant" ? "--font-noto-sans-tc" : "--font-noto-sans-sc";
  const cjkFont = /\p{Script=Hangul}/u.test(copy) ? "--font-noto-sans-kr"
    : /\p{Script=Han}/u.test(copy) ? hanFont : undefined;
  const cjkFamily = cjkFont ? fontStyle.getPropertyValue(cjkFont).trim() : "";
  const font = cjkFamily && !baseFont.startsWith(cjkFamily) ? cjkFamily + ", " + baseFont : baseFont;
  const visualFont = design.type === "editorial" && !cjkFont && !/^(?:ko|zh)(?:-|$)/.test(locale) ? "Georgia, " + font : font;
  const [image, logo] = await Promise.all([
    readImage(opts.source),
    opts.logo ? readImage(opts.logo) : null,
    document.fonts.load(`450 24px ${font}`, copy).catch(() => []),
    document.fonts.load(`850 48px ${visualFont}`, copy).catch(() => []),
  ]);

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.imageSmoothingQuality = "high";
  const unit = Math.min(width, height);
  const all: Box = { x: 0, y: 0, w: width, h: height };
  const [left, top, right, bottom] = placement?.safe ?? [.065, .055, .065, .055];
  const range = { x: width * left, y: height * top, w: width * (1 - left - right), h: height * (1 - top - bottom) };
  const region = (x: number, y: number, w: number, h: number): Box => ({
    x: range.x + range.w * x, y: range.y + range.h * y, w: range.w * w, h: range.h * h,
  });
  const fill = (b: Box, color: string | CanvasGradient) => {
    ctx.fillStyle = color;
    ctx.fillRect(b.x, b.y, b.w, b.h);
  };
  const words = new Intl.Segmenter(locale, { granularity: "word" });
  const glyphs = new Intl.Segmenter(locale, { granularity: "grapheme" });
  const drawTitle = (box: Box, align: "left" | "center" = "left", bottomAlign = false, scale = 1) =>
    textIn(ctx, { text: title, box, family: visualFont, weight: design.type === "quiet" ? 570 : design.type === "editorial" ? 700 : 850,
      size: unit * (design.type === "bold" ? .119 : .095) * scale, leading: 1.08, align, bottom: bottomAlign,
      spacing: design.type === "bold" ? -unit * .003 : 0, color: design.ink, words, glyphs });
  const drawDetails = (box: Box, align: "left" | "center" = "left") =>
    textIn(ctx, { text: details, box, family: font, weight: 450, size: unit * .034, leading: 1.29,
      color: design.ink, align, words, glyphs });
  const rule = (box: Box, broad = false) => fill({ ...box, w: broad ? box.w : Math.min(box.w, unit * .082), h: unit * (broad ? .0017 : .006) }, design.accent);
  const mark = (box: Box) => {
    if (!logo) return;
    fill(box, "#fffaf2");
    const pad = Math.min(box.w, box.h) * .12;
    imageIn(ctx, logo, { x: box.x + pad, y: box.y + pad, w: box.w - 2 * pad, h: box.h - 2 * pad }, "contain");
  };

  fill(all, design.paper);
  if (!title) {
    // Keep model-set typography inside the selected placement, even on a later resize.
    const y = placement && placement.safe[1] > .1 ? range.y : 0;
    const imageHeight = placement && placement.safe[1] > .1 ? range.h : height;
    const reserve = details || logo ? imageHeight * .25 : 0;
    imageIn(ctx, image, { x: 0, y, w: width, h: imageHeight - reserve }, "contain");
    const detailsArea = { x: range.x, y: y + imageHeight - reserve * .86, w: range.w * (logo ? .74 : 1), h: reserve * .73 };
    if (details) {
      rule({ ...detailsArea, y: detailsArea.y - unit * .02 }, true);
      drawDetails(detailsArea);
    }
    if (logo) mark({ x: range.x + range.w * .8, y: detailsArea.y, w: range.w * .2, h: reserve * .7 });
    return;
  }

  // Wide placements need a legible headline and a separate image anchor, even at thumbnail size.
  if (width > height * 1.15) {
    const hero = { x: width * .49, y: 0, w: width * .51, h: height };
    imageIn(ctx, image, hero);
    const fade = ctx.createLinearGradient(hero.x, 0, hero.x + width * .095, 0);
    fade.addColorStop(0, design.paper);
    fade.addColorStop(1, design.paper + "00");
    fill({ ...hero, w: width * .095 }, fade);
    if (logo) mark(region(0, 0, .16, .12));
    rule(region(0, .2, .1, .02));
    drawTitle(region(0, .25, .48, details ? .48 : .65), "left", false, 1.2);
    drawDetails(region(0, .76, .46, .23));
    return;
  }

  if (design.composition === "cover") {
    const fadeStart = range.y + range.h * .38;
    const heroEnd = range.y + range.h * .68;
    imageIn(ctx, image, { ...all, h: heroEnd }, "cover", .78);
    const transition = ctx.createLinearGradient(0, fadeStart, 0, heroEnd);
    transition.addColorStop(0, design.paper + "00");
    transition.addColorStop(.65, design.paper + "dc");
    transition.addColorStop(1, design.paper);
    fill({ x: 0, y: fadeStart, w: width, h: height - fadeStart }, transition);
    if (logo) mark(region(0, 0, .18, .09));
    rule(region(0, .49, .11, .02));
    drawTitle(region(0, .54, 1, details ? .25 : .43), "left", Boolean(details));
    if (details) {
      rule(region(0, .81, 1, .02), true);
      drawDetails(region(0, .84, 1, .16));
    }
    return;
  }

  if (placement && top > .1) {
    ctx.save();
    ctx.globalAlpha = .12;
    ctx.filter = `blur(${unit * .021}px)`;
    imageIn(ctx, image, all);
    ctx.restore();
  }

  if (design.composition === "split") {
    if (logo) mark(region(.82, 0, .18, .095));
    rule(region(0, .012, .13, .01));
    drawTitle(region(0, .047, logo ? .79 : 1, .25), "left", false, 1.02);
    const hero = region(0, .31, 1, details ? .47 : .68);
    imageIn(ctx, image, hero);
    if (details) {
      rule(region(0, .803, 1, .01), true);
      drawDetails(region(0, .831, 1, .169));
    }
    return;
  }

  if (design.composition === "framed") {
    const frame = region(.064, .006, .872, details ? .52 : .60);
    ctx.strokeStyle = design.accent;
    ctx.lineWidth = unit * .002;
    ctx.strokeRect(frame.x - unit * .011, frame.y - unit * .011, frame.w + unit * .022, frame.h + unit * .022);
    imageIn(ctx, image, frame, "cover", design.focalY);
    if (logo) mark(region(.77, .013, .15, .08));
    drawTitle(region(.04, details ? .58 : .666, .92, details ? .22 : .28), "center");
    if (details) {
      rule(region(0, .817, 1, .02), true);
      drawDetails(region(.055, .848, .89, .152), "center");
    }
    return;
  }

  const panel = region(0, .025, .89, .655);
  fill(region(.065, .064, .935, .62), design.accent);
  imageIn(ctx, image, panel);
  if (logo) mark(region(.76, .043, .2, .096));
  rule(region(0, .71, 1, .013), true);
  drawTitle(region(0, .744, details ? .61 : 1, .255), "left", false, .83);
  drawDetails(region(.65, .758, .35, .242));
}

export async function renderStudioPublishingArtwork(options: StudioPublishingArtwork) {
  const canvas = document.createElement("canvas");
  await drawStudioPublishingArtwork(canvas, options);
  return encode(canvas);
}
