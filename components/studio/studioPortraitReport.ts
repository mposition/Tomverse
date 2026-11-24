import type { StudioAnalysisReport, StudioColorReport, StudioFaceReport } from "@/lib/studioCreativeAnalysis";
import { canvas, encode, readImage } from "./studioCanvas";
import { loadStudioReportTypography, type StudioReportTypography } from "./studioReportTypography";

const width = 1080;
const height = 1620;
const faceInk = "#20332f";
const faceAccent = "#3a6a5d";
const muted = "#52615b";
const colorInk = "#382a24";
const colorAccent = "#87543e";
const colorLine = "#e6d9ce";
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

function drawBrand(ctx: CanvasRenderingContext2D, logo: HTMLImageElement, x: number, baseline: number,
  ink: string, label: StudioReportTypography["label"]) {
  photo(ctx, logo, x, baseline - 20, 26, 26);
  label(ctx, studioName, x + 35, baseline, 18, 200, 700, ink);
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

function colorPage(ctx: CanvasRenderingContext2D, reference: HTMLImageElement, logo: HTMLImageElement, report: StudioColorReport,
  copy: Labels["color"], interpretation: string, locale: string, typography: StudioReportTypography) {
  const { label, paragraph, displayFamily } = typography;
  const paper = ctx.createLinearGradient(0, 0, width, height);
  paper.addColorStop(0, "#fcf8f1");
  paper.addColorStop(.58, "#f7efe5");
  paper.addColorStop(1, "#fbf5ed");
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, width, height);
  const margin = 26, content = width - 2 * margin;
  const caps = (value: string, x: number, y: number, max: number, size = 21, ink = colorInk) =>
    label(ctx, value.toLocaleUpperCase(locale), x, y, size, max, 680, ink);
  const display = (str: string, x: number, y: number, size: number, max: number) =>
    label(ctx, str, x, y, size, max, 720, colorInk, displayFamily);
  const value = (str: string, x: number, y: number, size: number, max: number) =>
    label(ctx, str, x, y, size, max, 530, colorInk);

  photo(ctx, reference, 586, 26, 468, 465);
  drawBrand(ctx, logo, 54, 42, colorAccent, label);
  display(copy.title[0], 51, 116, 69, 485);
  display(copy.title[1], 51, 186, 69, 490);
  ctx.fillStyle = colorLine;
  ctx.fillRect(53, 211, 490, 1.5);

  box(ctx, 45, 235, 511, 256, "#f1e3d6");
  caps(copy.season, 75, 269, 432, 18, colorAccent);
  display(report.season, 72, 341, 58, 445);
  report.recommendedPalette.slice(0, 5).forEach((color, i) => dot(ctx, 112 + i * 78, 395, 29, color));
  paragraph(ctx, report.summary, 75, 451, 443, 19, 2, "#5f4e43");

  const cardGap = 9, cardWidth = (content - 2 * cardGap) / 3;
  [report.features.hair, report.features.eyes, report.features.skin].forEach((feature, index) => {
    const x = margin + index * (cardWidth + cardGap);
    box(ctx, x, 507, cardWidth, 164, "#fffcf7");
    frame(ctx, x, 507, cardWidth, 164, colorLine);
    caps(copy.features[index], x + 21, 536, cardWidth - 42, 19);
    if (feature.region) photo(ctx, reference, x + 18, 548, cardWidth - 116, 109, feature.region);
    dot(ctx, x + cardWidth - 53, 582, 22, feature.color);
    ctx.textAlign = "center";
    value(feature.name, x + cardWidth - 53, 634, 19, 89);
    ctx.textAlign = "left";
  });

  const profiles = [report.profile.undertone, report.profile.contrast, report.profile.tone];
  profiles.forEach((profile, index) => {
    const x = margin + index * (cardWidth + cardGap);
    box(ctx, x, 685, cardWidth, 130, "#f3e9de");
    caps(copy.profile[index], x + 25, 713, cardWidth - 50, 19);
    const colors = "colors" in profile ? profile.colors : [profile.color];
    if (index < 2) {
      colors.forEach((color, i) => dot(ctx, x + 64 + 58 * i, 765, 23, color));
      const offset = colors.length === 1 ? 106 : 160;
      value(profile.name, x + offset, 773, 23, cardWidth - offset - 17);
    } else {
      colors.forEach((color, i) => dot(ctx, x + cardWidth / 2 - 87 + i * 58, 753, 19, color));
      ctx.textAlign = "center";
      value(profile.name, x + cardWidth / 2, 799, 21, cardWidth - 36);
      ctx.textAlign = "left";
    }
  });

  const rows = [report.recommended, report.comparison];
  const previews = garmentPreviews(reference, report.garment, rows.flat().map(item => item.color));
  rows.forEach((collection, row) => {
    const y = 830 + row * 277, markerX = margin + 32, markerY = y + 24;
    const accent = row === 0 ? "#46634c" : "#934c42";
    box(ctx, margin, y, content, 262, "#fffcf7");
    frame(ctx, margin, y, content, 262, colorLine);
    dot(ctx, markerX, markerY, 13, accent);
    ctx.strokeStyle = "#fffaf3";
    ctx.lineWidth = 2;
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
    caps(row === 0 ? copy.recommended : copy.comparison, margin + 55, y + 32, content - 77, 22, accent);

    const gap = 13, tileWidth = (content - 26 - gap * 5) / 6;
    collection.forEach((item, index) => {
      const x = margin + 13 + index * (tileWidth + gap);
      photo(ctx, previews[row * 6 + index], x, y + 48, tileWidth, 167);
      dot(ctx, x + 17, y + 237, 9, item.color);
      value(item.name, x + 34, y + 244, 18, tileWidth - 38);
    });
  });

  [report.recommendedPalette, report.comparisonPalette].forEach((palette, index) => {
    const gap = 14, panelWidth = (content - gap) / 2;
    const x = margin + index * (panelWidth + gap);
    box(ctx, x, 1385, panelWidth, 120, "#f1e6db");
    caps(copy.palettes[index], x + 20, 1417, panelWidth - 40, 18);
    const step = (panelWidth - 40) / palette.length;
    palette.forEach((color, position) => dot(ctx, x + 20 + step * (position + .5), 1463, Math.min(19, step / 2 - 2), color));
  });

  ctx.fillStyle = colorLine;
  ctx.fillRect(width / 2 - 30, 1524, 60, 1.5);
  ctx.textAlign = "center";
  value(copy.basis, width / 2, 1552, 17, content);
  value(interpretation, width / 2, 1575, 16, content);
  label(ctx, studioUrl, width / 2, 1600, 15, content, 520, colorInk);
  ctx.textAlign = "left";
}

function drawFaceGuides(ctx: CanvasRenderingContext2D, image: HTMLImageElement, guides: StudioFaceReport["guides"],
  x: number, y: number, w: number, h: number, names: Labels["face"]["thirds"], label: StudioReportTypography["label"]) {
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
  ctx.lineWidth = 1.4;
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
    ctx.strokeStyle = "#29473e";
    ctx.beginPath();
    ctx.moveTo(edge + 14, top);
    ctx.lineTo(edge, top);
    ctx.lineTo(edge, bottom);
    ctx.lineTo(edge + 14, bottom);
    ctx.stroke();
    const center = (top + bottom) / 2;
    box(ctx, x + 11, center - 17, 89, 30, "#f4faf5ef");
    label(ctx, names[i], x + 18, center + 3, 15, 75, 650, faceInk);
  });
  ctx.setLineDash([]);
  guides.markers.forEach(({ label: marker, point: [mx, my] }) => {
    const anchorX = px(mx), anchorY = py(my);
    if (anchorX <= x || anchorX >= x + w || anchorY < y + 27 || anchorY > y + h - 27) return;
    const captionX = x + w - 142;
    const captionY = anchorY - 18;
    ctx.strokeStyle = "#29473e";
    ctx.beginPath();
    ctx.moveTo(anchorX, anchorY);
    ctx.lineTo(captionX, captionY);
    ctx.stroke();
    dot(ctx, anchorX, anchorY, 4, faceAccent);
    box(ctx, captionX, captionY - 16, 132, 32, "#f5faf5ef");
    label(ctx, marker, captionX + 7, captionY + 6, 15, 118, 620, faceInk);
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

function facePage(ctx: CanvasRenderingContext2D, reference: HTMLImageElement, logo: HTMLImageElement, report: StudioFaceReport,
  copy: Labels["face"], interpretation: string, locale: string, typography: StudioReportTypography) {
  const { label, paragraph } = typography;
  ctx.fillStyle = "#f4f7f3";
  ctx.fillRect(0, 0, width, height);
  const number = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const margin = 19, content = width - 2 * margin;
  const stroke = "#dbe4db";
  drawBrand(ctx, logo, width / 2 - 87, 30, faceAccent, label);
  ctx.textAlign = "center";
  label(ctx, copy.title, width / 2, 87, 56, content - 50, 750, faceInk);
  label(ctx, copy.lead, width / 2, 120, 21, content - 50, 480, muted);
  ctx.textAlign = "left";

  box(ctx, margin, 140, 427, 581, "#e9f1eb");
  frame(ctx, margin, 140, 427, 581, stroke);
  label(ctx, copy.overall, 47, 186, 25, 375, 710, faceAccent);
  const total = number.format(report.score);
  label(ctx, total, 45, 275, 80, 265, 770, faceInk);
  label(ctx, "/ 10", 58 + ctx.measureText(total).width, 275, 32, 125, 580, "#667b71");
  paragraph(ctx, report.summary, 47, 312, 370, 19, 3);
  ctx.fillStyle = "#cfdfd4";
  ctx.fillRect(47, 370, 370, 1);
  report.metrics.forEach((item, index) => {
    const y = 398 + index * 28;
    label(ctx, item.label, 47, y, 17, 152, 550, faceInk);
    box(ctx, 207, y - 11, 159, 8, "#d7e4db");
    box(ctx, 207, y - 11, 159 * item.score / 10, 8, "#558073");
    ctx.textAlign = "right";
    label(ctx, number.format(item.score), 418, y, 17, 44, 650, faceAccent);
    ctx.textAlign = "left";
  });
  box(ctx, 461, 140, 600, 581, "#fffefb");
  photo(ctx, reference, 470, 149, 582, 563);
  drawFaceGuides(ctx, reference, report.guides, 470, 149, 582, 563, copy.thirds, label);
  frame(ctx, 461, 140, 600, 581, stroke);

  box(ctx, margin, 743, content, 329, "#fffefb");
  frame(ctx, margin, 743, content, 329, stroke);
  label(ctx, copy.breakdown, 41, 786, 26, content - 42, 730, faceInk);
  const featureGap = 12, featureWidth = (content - 36 - 5 * featureGap) / 6;
  report.observations.forEach((item, index) => {
    const x = margin + 18 + index * (featureWidth + featureGap);
    if (item.region) photo(ctx, reference, x, 808, featureWidth, 121, item.region);
    else box(ctx, x, 808, featureWidth, 121, "#edf2eb");
    label(ctx, item.label, x, 957, 19, featureWidth, 680, faceInk);
    label(ctx, number.format(item.score), x, 985, 23, featureWidth, 760, faceAccent);
    label(ctx, "/ 10", x + ctx.measureText(number.format(item.score)).width + 5, 985, 15, 53, 520, muted);
    paragraph(ctx, item.note, x, 1010, featureWidth, 16, 3);
  });

  box(ctx, margin, 1090, content, 358, "#fffefb");
  frame(ctx, margin, 1090, content, 358, stroke);
  label(ctx, copy.tips, 41, 1133, 26, content - 42, 730, faceInk);
  const gap = 11, cardWidth = (content - 35 - 3 * gap) / 4;
  report.tips.forEach((tip, index) => {
    const x = margin + 17 + index % 4 * (cardWidth + gap);
    const y = 1151 + Math.floor(index / 4) * 143;
    box(ctx, x, y, cardWidth, 130, "#edf3ed");
    dot(ctx, x + 29, y + 35, 18, "#dde9df");
    ctx.save();
    ctx.translate(x + 18, y + 24);
    ctx.scale(.92, .92);
    ctx.lineWidth = 1.65;
    ctx.strokeStyle = faceAccent;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(tipPaths[index]));
    ctx.restore();
    label(ctx, tip.label, x + 55, y + 35, 17, cardWidth - 66, 700, faceInk);
    paragraph(ctx, tip.note, x + 55, y + 62, cardWidth - 66, 15, 3);
  });

  ctx.fillStyle = stroke;
  ctx.fillRect(41, 1473, content - 44, 1);
  label(ctx, copy.notes, 41, 1508, 20, content - 50, 690, faceInk);
  paragraph(ctx, interpretation, 41, 1540, content - 47, 16, 2);
  ctx.textAlign = "center";
  label(ctx, studioUrl, width / 2, 1600, 15, content, 520, muted);
  ctx.textAlign = "left";
}

export async function renderStudioPortraitReport(source: string, report: StudioAnalysisReport, copy: Labels, locale: string) {
  const [reference, logo, typography] = await Promise.all([
    readImage(source),
    readImage("/tomverse-logo.png"),
    loadStudioReportTypography(locale, JSON.stringify({ report, copy }) + studioName + studioUrl),
  ]);
  const { element, context } = canvas(width, height);
  if ("season" in report) colorPage(context, reference, logo, report, copy.color, copy.interpretation, locale, typography);
  else facePage(context, reference, logo, report, copy.face, copy.interpretation, locale, typography);
  return encode(element);
}
