import type { StudioAnalysisReport, StudioColorReport, StudioFaceReport } from "@/lib/studioCreativeAnalysis";
import { canvas, encode, readImage } from "./studioCanvas";

const width = 1080;
const height = 1620;
const text = "#0f100f";
const muted = "#434744";
const colorInk = "#302419";
const colorLine = "#d8cbbb";
const font = "system-ui, sans-serif";
const serif = 'Georgia, "Noto Serif CJK KR", Batang, serif';
const studioName = "Tomverse Studio";
const studioUrl = "https://tomverse.app";

type Region = [number, number, number, number];
type Labels = {
  interpretation: string;
  color: {
    title: [string, string];
    season: string;
    recommended: string;
    comparison: string;
    features: [string, string, string];
    profile: [string, string, string];
    palettes: [string, string];
    basis: string;
  };
  face: {
    title: string;
    lead: string;
    overall: string;
    breakdown: string;
    tips: string;
    notes: string;
    thirds: [string, string, string];
  };
};

function label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number,
  size: number, max: number, weight = 700, color = text, family = font) {
  ctx.fillStyle = color;
  ctx.font = weight + " " + size + "px " + family;
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

function frame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 16);
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#30241931";
  ctx.lineWidth = 1;
  ctx.stroke();
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

function colorPage(ctx: CanvasRenderingContext2D, reference: HTMLImageElement, report: StudioColorReport,
  copy: Labels["color"], interpretation: string, locale: string) {
  const paper = ctx.createLinearGradient(0, 0, width, height);
  paper.addColorStop(0, "#f8f3ec");
  paper.addColorStop(.58, "#f3ede4");
  paper.addColorStop(1, "#f7f0e7");
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, width, height);
  const margin = 26, content = width - 2 * margin;
  const caps = (value: string, x: number, y: number, max: number, size = 21) =>
    label(ctx, value.toLocaleUpperCase(locale), x, y, size, max, 630, colorInk);
  const value = (str: string, x: number, y: number, size: number, max: number) =>
    label(ctx, str, x, y, size, max, 500, colorInk, serif);

  photo(ctx, reference, 586, 20, 468, 471);
  label(ctx, studioName, 57, 31, 19, 480, 680, colorInk);
  value(copy.title[0], 54, 105, 75, 485);
  value(copy.title[1], 54, 177, 75, 490);
  ctx.fillStyle = colorLine;
  ctx.fillRect(55, 199, 486, 1.5);

  frame(ctx, 48, 243, 508, 248, colorLine);
  ctx.fillStyle = "#f7f2eb";
  ctx.fillRect(57, 226, 214, 24);
  caps(copy.season, 62, 244, 203);
  value(report.season, 81, 327, 67, 449);
  report.recommendedPalette.slice(0, 5).forEach((color, i) => dot(ctx, 123 + i * 89, 392, 36, color));
  ctx.textAlign = "center";
  value(report.summary, 302, 462, 22, 457);
  ctx.textAlign = "left";

  const cardGap = 9, cardWidth = (content - 2 * cardGap) / 3;
  [report.features.hair, report.features.eyes, report.features.skin].forEach((feature, index) => {
    const x = margin + index * (cardWidth + cardGap);
    frame(ctx, x, 507, cardWidth, 164, colorLine);
    caps(copy.features[index], x + 21, 536, cardWidth - 42, 19);
    if (feature.region) photo(ctx, reference, x + 18, 548, cardWidth - 116, 109, feature.region);
    dot(ctx, x + cardWidth - 51, 582, 24, feature.color);
    ctx.textAlign = "center";
    value(feature.name, x + cardWidth - 51, 634, 21, 86);
    ctx.textAlign = "left";
  });

  const profiles = [report.profile.undertone, report.profile.contrast, report.profile.tone];
  profiles.forEach((profile, index) => {
    const x = margin + index * (cardWidth + cardGap);
    frame(ctx, x, 685, cardWidth, 130, colorLine);
    caps(copy.profile[index], x + 25, 713, cardWidth - 50, 19);
    const colors = "colors" in profile ? profile.colors : [profile.color];
    if (index < 2) {
      colors.forEach((color, i) => dot(ctx, x + 64 + 58 * i, 765, 27, color));
      const offset = colors.length === 1 ? 106 : 160;
      value(profile.name, x + offset, 773, 26, cardWidth - offset - 17);
    } else {
      colors.forEach((color, i) => dot(ctx, x + cardWidth / 2 - 94 + i * 62, 755, 24, color));
      ctx.textAlign = "center";
      value(profile.name, x + cardWidth / 2, 802, 24, cardWidth - 36);
      ctx.textAlign = "left";
    }
  });

  const rows = [report.recommended, report.comparison];
  const previews = garmentPreviews(reference, report.garment, rows.flat().map(item => item.color));
  rows.forEach((collection, row) => {
    const y = 830 + row * 277, markerX = margin + 35, markerY = y + 26;
    frame(ctx, margin, y, content, 262, colorLine);
    dot(ctx, markerX, markerY, 17, row === 0 ? "#416540" : "#b34333");
    ctx.strokeStyle = "#fffaf3";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(markerX - 7, markerY + (row === 0 ? 1 : -7));
    if (row === 0) {
      ctx.lineTo(markerX - 2, markerY + 5);
      ctx.lineTo(markerX + 8, markerY - 6);
    } else {
      ctx.lineTo(markerX + 7, markerY + 7);
      ctx.moveTo(markerX + 7, markerY - 7);
      ctx.lineTo(markerX - 7, markerY + 7);
    }
    ctx.stroke();
    caps(row === 0 ? copy.recommended : copy.comparison, margin + 64, y + 34, content - 77, 23);

    const gap = 13, tileWidth = (content - 26 - gap * 5) / 6;
    collection.forEach((item, index) => {
      const x = margin + 13 + index * (tileWidth + gap);
      photo(ctx, previews[row * 6 + index], x, y + 48, tileWidth, 167);
      dot(ctx, x + 21, y + 238, 13, item.color);
      value(item.name, x + 42, y + 245, 19, tileWidth - 47);
    });
  });

  [report.recommendedPalette, report.comparisonPalette].forEach((palette, index) => {
    const gap = 14, panelWidth = (content - gap) / 2;
    const x = margin + index * (panelWidth + gap);
    frame(ctx, x, 1385, panelWidth, 120, colorLine);
    caps(copy.palettes[index], x + 20, 1417, panelWidth - 40, 18);
    const step = (panelWidth - 40) / palette.length;
    palette.forEach((color, position) => dot(ctx, x + 20 + step * (position + .5), 1463, Math.min(22, step / 2 - 2), color));
  });

  ctx.textAlign = "center";
  value(copy.basis, width / 2, 1550, 20, content);
  value(interpretation, width / 2, 1573, 19, content);
  label(ctx, studioUrl, width / 2, 1600, 15, content, 520, colorInk);
  ctx.textAlign = "left";
}

function drawFaceGuides(ctx: CanvasRenderingContext2D, image: HTMLImageElement, guides: StudioFaceReport["guides"],
  x: number, y: number, w: number, h: number, names: Labels["face"]["thirds"]) {
  if (!guides) return;
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
  const iw = image.naturalWidth * scale, ih = image.naturalHeight * scale;
  const px = (value: number) => x + (w - iw) / 2 + value * iw;
  const py = (value: number) => y + (h - ih) / 2 + value * ih;
  const axis = px(guides.axis);
  const thirds = guides.thirds.map(py);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 12);
  ctx.clip();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#ffffffe8";
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(axis, y);
  ctx.lineTo(axis, y + h);
  ctx.stroke();

  const edge = x + 104;
  thirds.slice(0, -1).forEach((top, i) => {
    const bottom = thirds[i + 1];
    if (top < y + 9 || bottom > y + h - 9) return;
    ctx.strokeStyle = "#3a3a38";
    ctx.beginPath();
    ctx.moveTo(edge + 14, top);
    ctx.lineTo(edge, top);
    ctx.lineTo(edge, bottom);
    ctx.lineTo(edge + 14, bottom);
    ctx.stroke();
    const center = (top + bottom) / 2;
    box(ctx, x + 11, center - 17, 89, 30, "#ffffffdf");
    label(ctx, names[i], x + 18, center + 3, 15, 75, 650);
  });
  ctx.setLineDash([]);
  guides.markers.forEach(({ label: marker, point: [mx, my] }) => {
    const anchorX = px(mx), anchorY = py(my);
    if (anchorX <= x || anchorX >= x + w || anchorY < y + 27 || anchorY > y + h - 27) return;
    const captionX = x + w - 142;
    const captionY = anchorY - 18;
    ctx.strokeStyle = "#292925";
    ctx.beginPath();
    ctx.moveTo(anchorX, anchorY);
    ctx.lineTo(captionX, captionY);
    ctx.stroke();
    dot(ctx, anchorX, anchorY, 4, "#222322");
    box(ctx, captionX, captionY - 16, 132, 32, "#ffffffed");
    label(ctx, marker, captionX + 7, captionY + 6, 15, 118, 620);
  });
  ctx.restore();
}

const tipPaths = [
  "M6 17a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm15-14L8 18M8 8l11 12M6 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm14 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z",
  "M4 13v-2a8 8 0 0 1 16 0v2M4 12c3 0 5-2 7-4 3 3 5 4 9 4v3a8 8 0 0 1-16 0Z",
  "M3 12c3-2 6-3 9-2 3-1 6 0 9 2-3 4-6 5-9 5s-6-1-9-5Zm1 1h16",
  "M2 15c4-5 9-7 14-7l6 3M4 18c6-5 12-6 17-4",
  "M12 2 13.5 8.5 20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5ZM18 16l1 3 3 1-3 1-1 3-1-3-3-1 3-1Z",
  "M12 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM5 21v-5a7 7 0 0 1 14 0v5M9 16v7m6-7v7",
  "M8 4 3 7l-2 5 5 2v8h12v-8l5-2-2-5-5-3c-1 3-7 3-8 0Z",
  "M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0-6v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2m0-16-2 2M6 18l-2 2",
];

function facePage(ctx: CanvasRenderingContext2D, reference: HTMLImageElement, report: StudioFaceReport,
  copy: Labels["face"], interpretation: string, locale: string) {
  ctx.fillStyle = "#fdfdfc";
  ctx.fillRect(0, 0, width, height);
  const number = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const margin = 19, content = width - 2 * margin;
  const stroke = "#d1d0cb", ink = "#252625";
  ctx.textAlign = "center";
  label(ctx, studioName, width / 2, 25, 19, content - 50, 680, muted);
  label(ctx, copy.title, width / 2, 82, 60, content - 50, 790);
  label(ctx, copy.lead, width / 2, 117, 24, content - 50, 500, muted);
  ctx.textAlign = "left";

  frame(ctx, margin, 140, 427, 581, stroke);
  label(ctx, copy.overall, 42, 186, 28, 382, 760);
  const total = number.format(report.score);
  label(ctx, total, 42, 274, 78, 265, 780);
  label(ctx, "/ 10", 53 + ctx.measureText(total).width, 274, 38, 125, 620, "#767873");
  paragraph(ctx, report.summary, 43, 309, 376, 21, 3);
  report.metrics.forEach((item, index) => {
    const y = 388 + index * 29;
    label(ctx, item.label, 43, y, 17, 157, 560);
    box(ctx, 207, y - 13, 159, 12, "#e3e3e0");
    box(ctx, 207, y - 13, 159 * item.score / 10, 12, "#373936");
    ctx.textAlign = "right";
    label(ctx, number.format(item.score), 418, y, 17, 44, 630);
    ctx.textAlign = "left";
  });
  photo(ctx, reference, 461, 140, 600, 581);
  drawFaceGuides(ctx, reference, report.guides, 461, 140, 600, 581, copy.thirds);
  frame(ctx, 461, 140, 600, 581, stroke);

  frame(ctx, margin, 743, content, 329, stroke);
  label(ctx, copy.breakdown, 40, 786, 28, content - 42, 760);
  const featureGap = 12, featureWidth = (content - 36 - 5 * featureGap) / 6;
  report.observations.forEach((item, index) => {
    const x = margin + 18 + index * (featureWidth + featureGap);
    if (item.region) photo(ctx, reference, x, 808, featureWidth, 121, item.region);
    else box(ctx, x, 808, featureWidth, 121, "#efefeb");
    label(ctx, item.label, x, 955, 19, featureWidth, 670);
    label(ctx, number.format(item.score), x, 984, 25, featureWidth, 760);
    label(ctx, "/ 10", x + ctx.measureText(number.format(item.score)).width + 4, 984, 18, 53, 520, "#767873");
    paragraph(ctx, item.note, x, 1010, featureWidth, 16, 3);
  });

  frame(ctx, margin, 1090, content, 358, stroke);
  label(ctx, copy.tips, 40, 1133, 28, content - 42, 760);
  const gap = 11, cardWidth = (content - 35 - 3 * gap) / 4;
  report.tips.forEach((tip, index) => {
    const x = margin + 17 + index % 4 * (cardWidth + gap);
    const y = 1151 + Math.floor(index / 4) * 143;
    frame(ctx, x, y, cardWidth, 130, "#dededb");
    ctx.save();
    ctx.translate(x + 15, y + 22);
    ctx.scale(1.27, 1.27);
    ctx.lineWidth = 1.55;
    ctx.strokeStyle = ink;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(tipPaths[index]));
    ctx.restore();
    label(ctx, tip.label, x + 57, y + 34, 18, cardWidth - 70);
    paragraph(ctx, tip.note, x + 57, y + 58, cardWidth - 70, 16, 3);
  });

  frame(ctx, margin, 1465, content, 113, stroke);
  label(ctx, copy.notes, 40, 1505, 25, content - 50, 730);
  paragraph(ctx, interpretation, 40, 1542, content - 47, 19, 2);
  ctx.textAlign = "center";
  label(ctx, studioUrl, width / 2, 1600, 15, content, 520, muted);
  ctx.textAlign = "left";
}

export async function renderStudioPortraitReport(source: string, report: StudioAnalysisReport, copy: Labels, locale: string) {
  const reference = await readImage(source);
  const { element, context } = canvas(width, height);
  if ("season" in report) colorPage(context, reference, report, copy.color, copy.interpretation, locale);
  else facePage(context, reference, report, copy.face, copy.interpretation, locale);
  return encode(element);
}
