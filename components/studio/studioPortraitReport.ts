import type { StudioAnalysisReport, StudioColorReport, StudioFaceReport } from "@/lib/studioCreativeAnalysis";
import { canvas, encode, readImage } from "./studioCanvas";

const width = 1080;
const paper = "#f8f3ea";
const text = "#18332e";
const muted = "#50645c";
const line = "#dcd8ca";
const mint = "#dce9dd";
const rose = "#edddd6";
const font = "system-ui, sans-serif";
const left = 48;
const inner = width - left * 2;

type Region = [number, number, number, number];
type Labels = {
  heading: string;
  season: string;
  overall: string;
  breakdown: string;
  tips: string;
  recommended: string;
  comparison: string;
  features: [string, string, string];
};

function label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number,
  size: number, max: number, weight = 700, color = text) {
  ctx.fillStyle = color;
  ctx.font = weight + " " + size + "px " + font;
  ctx.fillText(value, x, y, max);
}

function paragraph(ctx: CanvasRenderingContext2D, message: string, x: number, y: number, max: number, size: number, maxLines: number) {
  ctx.fillStyle = muted;
  ctx.font = "500 " + size + "px " + font;
  let chunk = "", index = 1;
  for (const char of message) {
    if (chunk && ctx.measureText(chunk + char).width > max) {
      if (index === maxLines) {
        ctx.fillText(chunk.slice(0, -1) + "…", x, y);
        return;
      }
      ctx.fillText(chunk.trimEnd(), x, y);
      chunk = "";
      y += size * 1.3;
      index++;
    }
    chunk += char;
  }
  if (chunk) ctx.fillText(chunk, x, y);
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 16);
  ctx.fill();
}

function photo(ctx: CanvasRenderingContext2D, image: HTMLImageElement | HTMLCanvasElement, x: number, y: number, w: number, h: number,
  region?: Region | null) {
  const iw = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const ih = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  const [rx, ry, rw, rh] = region ?? [0, 0, 1, 1];
  const sw = iw * rw, sh = ih * rh;
  const scale = Math.max(w / sw, h / sh);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 12);
  ctx.clip();
  ctx.drawImage(image, iw * rx, ih * ry, sw, sh, x + (w - sw * scale) / 2, y + (h - sh * scale) / 2, sw * scale, sh * scale);
  ctx.restore();
}

function garmentPreviews(image: HTMLImageElement, polygon: StudioColorReport["garment"], colors: string[]) {
  const w = 240, h = 260;
  const base = canvas(w, h);
  photo(base.context, image, 0, 0, w, h);
  const mask = canvas(w, h);
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
  const sw = image.naturalWidth * scale, sh = image.naturalHeight * scale;
  if (polygon && polygon.every(([, y]) => y >= .33)) {
    mask.context.beginPath();
    polygon.forEach(([x, y], index) => {
      const px = (w - sw) / 2 + x * sw, py = (h - sh) / 2 + y * sh;
      if (index === 0) mask.context.moveTo(px, py);
      else mask.context.lineTo(px, py);
    });
    mask.context.closePath();
    mask.context.fill();
  }
  const coverage = mask.context.getImageData(0, 0, w, h).data;
  const original = base.context.getImageData(0, 0, w, h);
  let total = 0, count = 0;
  const luma = (i: number) => original.data[i] * .2126 + original.data[i + 1] * .7152 + original.data[i + 2] * .0722;
  for (let i = 0; i < coverage.length; i += 4) {
    if (coverage[i + 3] >= 220 && original.data[i + 3] >= 220) {
      total += luma(i);
      count++;
    }
  }
  return colors.map(color => {
    const output = canvas(w, h);
    if (count < w * h * .02 || count > w * h * .5) {
      box(output.context, 0, 0, w, h, color);
      photo(output.context, image, 12, 10, w - 24, h - 36);
    } else {
      const processed = new ImageData(new Uint8ClampedArray(original.data), w, h);
      const channels = color.slice(1).match(/../g)!.map(component => parseInt(component, 16));
      for (let i = 0; i < coverage.length; i += 4) {
        if (!coverage[i + 3]) continue;
        const opacity = coverage[i + 3] / 255;
        const shading = (luma(i) - total / count) * .68;
        channels.forEach((channel, offset) => {
          processed.data[i + offset] = original.data[i + offset] * (1 - opacity) + (channel + shading) * opacity;
        });
      }
      output.context.putImageData(processed, 0, 0);
    }
    return output.element;
  });
}

function colorPage(ctx: CanvasRenderingContext2D, reference: HTMLImageElement, report: StudioColorReport, copy: Labels) {
  photo(ctx, reference, left, 179, 424, 437);
  box(ctx, 500, 179, 532, 437, "#ececdf");
  label(ctx, copy.season, 527, 229, 25, 470, 700, muted);
  label(ctx, report.season, 527, 292, 55, 476);
  paragraph(ctx, report.summary, 527, 333, 470, 24, 3);
  const features = [report.features.hair, report.features.eyes, report.features.skin];
  features.forEach((feature, index) => {
    const x = 527 + index * 157;
    box(ctx, x, 467, 135, 82, feature.color);
    if (feature.region) {
      photo(ctx, reference, x, 467, 135, 66, feature.region);
      ctx.fillStyle = feature.color;
      ctx.fillRect(x + 9, 521, 117, 12);
    }
    label(ctx, copy.features[index], x, 578, 22, 135, 700);
  });
  const items = [...report.recommended, ...report.comparison];
  const previews = garmentPreviews(reference, report.garment, items.map(item => item.color));
  for (const [row, collection] of [report.recommended, report.comparison].entries()) {
    const y = 656 + row * 360;
    const rowLabel = row === 0 ? copy.recommended : copy.comparison;
    box(ctx, left, y, inner, 46, row === 0 ? mint : rose);
    label(ctx, rowLabel, left + 14, y + 31, 25, inner - 28);
    const gap = 12, tileWidth = (inner - gap * 5) / 6;
    collection.forEach((item, index) => {
      const x = left + index * (tileWidth + gap);
      photo(ctx, previews[row * 6 + index], x, y + 62, tileWidth, 173);
      box(ctx, x, y + 246, tileWidth, 21, item.color);
      label(ctx, item.name, x + 2, y + 298, 23, tileWidth - 4, 650);
    });
  }
  ctx.fillStyle = line;
  ctx.fillRect(left, 1353, inner, 2);
  for (const [index, palette] of [report.recommended, report.comparison].entries()) {
    const x = left + index * 508;
    label(ctx, index === 0 ? copy.recommended : copy.comparison, x, 1391, 22, 476, 650, muted);
    palette.forEach((item, position) => box(ctx, x + position * 79, 1406, 72, 26, item.color));
  }
}

function facePage(ctx: CanvasRenderingContext2D, reference: HTMLImageElement, report: StudioFaceReport, copy: Labels, locale: string) {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  photo(ctx, reference, left, 179, 424, 449);
  box(ctx, 500, 179, 532, 449, mint);
  label(ctx, copy.overall, 527, 224, 25, 474, 720, muted);
  label(ctx, number.format(report.score) + " / 10", 527, 310, 72, 474);
  paragraph(ctx, report.summary, 527, 352, 470, 23, 3);
  report.observations.forEach((item, index) => {
    const y = 452 + index * 27;
    label(ctx, item.label, 528, y, 20, 170, 650);
    box(ctx, 711, y - 13, 210, 9, "#b7ccb8");
    box(ctx, 711, y - 13, 210 * item.score / 10, 9, "#48755f");
    label(ctx, number.format(item.score), 941, y, 20, 55, 700);
  });

  label(ctx, copy.breakdown, left, 682, 35, inner);
  const gap = 16, cardWidth = (inner - gap * 2) / 3;
  report.observations.forEach((item, index) => {
    const x = left + (index % 3) * (cardWidth + gap);
    const y = 700 + Math.floor(index / 3) * 255;
    box(ctx, x, y, cardWidth, 239, "#f1ebdf");
    if (item.region) photo(ctx, reference, x + 10, y + 10, cardWidth - 20, 110, item.region);
    else box(ctx, x + 10, y + 10, cardWidth - 20, 110, "#e6e5d6");
    label(ctx, item.label, x + 13, y + 153, 25, cardWidth - 91);
    label(ctx, number.format(item.score), x + cardWidth - 74, y + 153, 25, 58, 730, "#36624f");
    paragraph(ctx, item.note, x + 13, y + 181, cardWidth - 28, 20, 3);
  });

  label(ctx, copy.tips, left, 1253, 34, inner);
  report.tips.forEach((tip, index) => {
    const x = left + index * (cardWidth + gap);
    box(ctx, x, 1274, cardWidth, 153, mint);
    label(ctx, tip.label, x + 15, 1316, 25, cardWidth - 30);
    paragraph(ctx, tip.note, x + 15, 1350, cardWidth - 30, 21, 3);
  });
}

export async function renderStudioPortraitReport(source: string, report: StudioAnalysisReport, copy: Labels, locale: string) {
  const reference = await readImage(source);
  const { element, context } = canvas(width, 1480);
  context.fillStyle = paper;
  context.fillRect(0, 0, width, element.height);
  label(context, "Tomverse Studio", left, 66, 29, inner, 720, muted);
  label(context, copy.heading, left, 135, 59, inner, 760);
  context.fillStyle = line;
  context.fillRect(left, 153, inner, 2);
  if ("season" in report) colorPage(context, reference, report, copy);
  else facePage(context, reference, report, copy, locale);
  return encode(element);
}
