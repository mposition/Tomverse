import {
  studioStickerArt, studioStickerCaptionOutside, studioStickerCaptionSlot, studioStickerCells, studioStickerCrossesSeam, type StickerRect,
} from "@/lib/studioStickerGeometry";
import { studioStickerLayout } from "@/lib/studioTools";
import type { Language } from "@/lib/language";
import { loadStudioStickerFont } from "./studioStickerFonts";

export const studioImageTypes = ["image/png", "image/jpeg", "image/webp"];
export const studioImageAccept = studioImageTypes.join(",");
export const studioImageLimit = 12 * 1024 * 1024;
const studioBlobs = new Map<string, Blob>();

export function createStudioObjectUrl(blob: Blob) {
  const url = URL.createObjectURL(blob);
  studioBlobs.set(url, blob);
  return url;
}

export function revokeStudioObjectUrl(url: string) {
  studioBlobs.delete(url);
  URL.revokeObjectURL(url);
}

export async function readStudioBlob(url: string): Promise<Blob> {
  const blob = studioBlobs.get(url);
  if (blob) return blob;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Studio image is unavailable");
  return response.blob();
}

export function validStudioImage(file: File) {
  return studioImageTypes.includes(file.type) && file.size > 0 && file.size <= studioImageLimit;
}

export function canvas(width: number, height: number) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const context = element.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas unavailable");
  return { element, context };
}

export function readImage(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = source;
  return image.decode().then(() => image);
}

export function encode(element: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    element.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode image")), "image/png");
  });
}

function drawImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  fit: "contain" | "cover",
) {
  const scale = (fit === "cover" ? Math.max : Math.min)(width / image.naturalWidth, height / image.naturalHeight);
  const scaledWidth = image.naturalWidth * scale;
  const scaledHeight = image.naturalHeight * scale;
  context.drawImage(image, (width - scaledWidth) / 2, (height - scaledHeight) / 2, scaledWidth, scaledHeight);
}

export async function renderStudioImage(
  source: string,
  options: { width: number; height: number; fit?: "contain" | "cover"; memeCaption?: string; bleed?: boolean },
): Promise<Blob> {
  const { width, height, fit = "cover", memeCaption } = options;
  const image = await readImage(source);
  const { element, context } = canvas(width, height);
  if (options.bleed) {
    context.fillStyle = "#14222c";
    context.fillRect(0, 0, width, height);
    context.save();
    context.filter = "blur(54px)";
    context.globalAlpha = .48;
    drawImage(context, image, width, height, "cover");
    context.restore();
  }
  drawImage(context, image, width, height, fit);
  if (memeCaption?.trim()) {
    const caption = memeCaption.trim();
    const family = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || "system-ui, sans-serif";
    await document.fonts.load(`850 24px ${family}`, caption).catch(() => []);
    const maxWidth = width * .88;
    const targetSize = width * .09;
    context.font = `850 ${targetSize}px ${family}`;
    const lines = context.measureText(caption).width > maxWidth ? splitCaption(caption) : [caption];
    const size = Math.min(targetSize, targetSize * maxWidth / Math.max(...lines.map(line => context.measureText(line).width)));
    const step = size * 1.1;
    context.font = `850 ${size}px ${family}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#fff4d8";
    context.strokeStyle = "#241812";
    context.lineWidth = size * .075;
    context.lineJoin = "round";
    lines.forEach((line, index) => {
      const y = height * .91 - step * (lines.length - index - .5);
      context.strokeText(line, width / 2, y);
      context.fillText(line, width / 2, y);
    });
  }
  return encode(element);
}

function splitCaption(text: string): string[] {
  const graphemes = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(part => part.segment)
    : Array.from(text);
  const middle = Math.ceil(graphemes.length / 2);
  let split = middle;
  for (let offset = 0; offset < graphemes.length / 4; offset++) {
    if (graphemes[middle - offset] === " ") { split = middle - offset; break; }
    if (graphemes[middle + offset] === " ") { split = middle + offset; break; }
  }
  return [graphemes.slice(0, split).join("").trimEnd(), graphemes.slice(split).join("").trimStart()];
}

export const STUDIO_STICKER_BACKGROUND = "#fff6e9";

export type StickerComposition = true | "opaque";

const stickerLineHeight = 1.16;
const stickerCaptionColors = [
  { hue: 292, ink: "#89519f", edge: "#e9ccfa" },
  { hue: 350, ink: "#a34a74", edge: "#f6c9df" },
  { hue: 28, ink: "#985429", edge: "#ffdbb4" },
  { hue: 119, ink: "#557544", edge: "#daedb9" },
  { hue: 177, ink: "#397a74", edge: "#bdeee5" },
  { hue: 226, ink: "#536aa3", edge: "#cddcfc" },
];

function stickerCaptionPalette(pixels: Uint8ClampedArray, stride: number, art: StickerRect) {
  const weights = stickerCaptionColors.map(() => 0);
  for (let y = art.top; y < art.top + art.height; y += 4) {
    for (let x = art.left; x < art.left + art.width; x += 4) {
      const index = (y * stride + x) * 4;
      if (pixels[index + 3] < 192) continue;
      const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
      const max = Math.max(red, green, blue);
      const chroma = max - Math.min(red, green, blue);
      if (chroma < 22 || max < 65) continue;
      const sector = max === red ? (green - blue) / chroma
        : max === green ? 2 + (blue - red) / chroma
        : 4 + (red - green) / chroma;
      const hue = (sector * 60 + 360) % 360;
      if (hue >= 12 && hue <= 52 && red > 160 && chroma < 105) continue;
      const distance = (other: number) => Math.min(Math.abs(other - hue), 360 - Math.abs(other - hue));
      const closest = stickerCaptionColors.reduce((best, color, i) => (
        distance(color.hue) < distance(stickerCaptionColors[best].hue) ? i : best
      ), 0);
      weights[closest] += chroma;
    }
  }
  return stickerCaptionColors[weights.indexOf(Math.max(...weights))];
}

function stickerCaption(
  context: CanvasRenderingContext2D, pixels: Uint8ClampedArray, stride: number, art: StickerRect, text: string,
  font: (size: number) => string,
) {
  const shortSide = Math.min(art.width, art.height);
  const maxSize = shortSide * .18;
  context.font = font(100);
  context.textAlign = "center";
  context.textBaseline = "middle";
  const measure = (lines: string[], maxWidth: number, maxHeight: number) => {
    const metrics = lines.map(line => context.measureText(line));
    const widest = metrics.map(line => Math.max(line.width, 2 * Math.max(line.actualBoundingBoxLeft, line.actualBoundingBoxRight)));
    const width = Math.max(1, ...widest) / 100 + .14;
    const height = Math.max(1, ...metrics.map(line => 2 * Math.max(line.actualBoundingBoxAscent, line.actualBoundingBoxDescent) / 100))
      + (lines.length - 1) * stickerLineHeight + .14;
    const size = Math.min(maxSize, maxWidth / width, maxHeight / height);
    return { lines, size, width: width * size, height: height * size };
  };
  const lineOptions = text.length > 6 ? [[text], splitCaption(text)] : [[text]];
  const choose = (width: number, height: number) => {
    const [single, wrapped] = lineOptions.map(lines => measure(lines, width, height));
    return wrapped && wrapped.size > single.size * 1.16 ? wrapped : single;
  };
  const { ink, edge } = stickerCaptionPalette(pixels, stride, art);
  const slot = studioStickerCaptionSlot(pixels, stride, art, Math.max(2, Math.round(art.height * .19)));
  if (slot && slot.width >= art.width * .5) {
    const label = choose(slot.width * .92, slot.height);
    if (label.size >= maxSize * .86) {
      const left = slot.left + (slot.width - label.width) / 2;
      const top = slot.top + (slot.height - label.height) / 2;
      let sum = 0, squares = 0, samples = 0;
      for (let y = Math.ceil(top); y < top + label.height; y += 2) {
        for (let x = Math.ceil(left); x < left + label.width; x += 2) {
          const i = (y * stride + x) * 4;
          const luma = pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722;
          sum += luma;
          squares += luma * luma;
          samples++;
        }
      }
      const brightness = sum / samples;
      if (squares / samples - brightness ** 2 < 16 ** 2) {
        return { ...label, left, top, ink: brightness < 128 ? edge : ink, edge: brightness < 128 ? ink : edge };
      }
    }
  }

  const label = choose(art.width * .86, shortSide * .40);
  const placement = studioStickerCaptionOutside(pixels, stride, art, label.width, label.height);
  return { ...label, ...placement, ink, edge };
}

async function renderStickerCell(image: HTMLImageElement, cell: StickerRect, caption: string, language: Language): Promise<Blob | null> {
  const sourceScale = Math.min(1, 512 / Math.max(cell.width, cell.height));
  const sourceWidth = Math.max(1, Math.round(cell.width * sourceScale));
  const sourceHeight = Math.max(1, Math.round(cell.height * sourceScale));
  const original = canvas(sourceWidth, sourceHeight);
  original.context.drawImage(image, cell.left, cell.top, cell.width, cell.height, 0, 0, sourceWidth, sourceHeight);
  const pixels = original.context.getImageData(0, 0, sourceWidth, sourceHeight).data;
  const art = studioStickerArt(pixels, sourceWidth, { left: 0, top: 0, width: sourceWidth, height: sourceHeight });
  if (!art) return null;
  const { left, top, width, height } = art;
  const padding = Math.max(1, Math.round(Math.max(width, height) * .025));
  const text = caption.trim();
  const font = await loadStudioStickerFont(language, text);
  original.element.lang = language;
  const label = text ? stickerCaption(original.context, pixels, sourceWidth, art, text, font) : null;
  const minX = Math.min(left, label?.left ?? left) - padding;
  const minY = Math.min(top, label?.top ?? top) - padding;
  const outputWidth = Math.max(left + width, label ? label.left + label.width : 0) + padding - minX;
  const outputHeight = Math.max(top + height, label ? label.top + label.height : 0) + padding - minY;
  const outputScale = 512 / Math.max(outputWidth, outputHeight);
  const output = canvas(Math.round(outputWidth * outputScale), Math.round(outputHeight * outputScale));
  output.element.lang = language;
  const { context } = output;
  fillStickerBackground(context);
  context.scale(outputScale, outputScale);
  context.drawImage(original.element, left, top, width, height, left - minX, top - minY, width, height);
  if (label) {
    const { lines, size, ink, edge } = label;
    context.font = font(size);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = ink;
    context.strokeStyle = edge;
    context.lineWidth = size * .065;
    context.lineJoin = "round";
    const x = label.left - minX + label.width / 2;
    const centerY = label.top - minY + label.height / 2;
    lines.forEach((line, index) => {
      const y = centerY + (index - (lines.length - 1) / 2) * size * stickerLineHeight;
      context.strokeText(line, x, y);
      context.fillText(line, x, y);
    });
  }
  return encode(output.element);
}

function fillStickerBackground(context: CanvasRenderingContext2D) {
  context.fillStyle = STUDIO_STICKER_BACKGROUND;
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
}

export async function renderStudioSticker(
  source: string, caption: string, language: Language, composed?: StickerComposition,
): Promise<Blob | null> {
  if (composed === "opaque") {
    return readStudioBlob(source);
  }
  const image = await readImage(source);
  if (composed) {
    // Existing checkout drafts have captions composed over alpha.
    const { element, context } = canvas(image.naturalWidth, image.naturalHeight);
    fillStickerBackground(context);
    context.drawImage(image, 0, 0);
    return encode(element);
  }
  return renderStickerCell(image, { left: 0, top: 0, width: image.naturalWidth, height: image.naturalHeight }, caption, language);
}

export async function makeStudioImageReference(source: string) {
  const image = await readImage(source);
  const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const { element, context } = canvas(width, height);
  drawImage(context, image, width, height, "contain");
  return encode(element);
}

export const studioStyleReferenceDirection =
  "The wide left panel is the subject reference. The narrow right panel contains material, color and lighting samples. Use the left panel for the person's identity and the right panel only for the chosen look. Output one complete image with no panel layout.";

export async function makeStudioStyleReference(source: string, styleSource: string) {
  const [subject, style] = await Promise.all([readImage(source), readImage(styleSource)]);
  const { element, context } = canvas(1024, 1024);
  const subjectWidth = 730;
  const stripLeft = 746;
  const stripWidth = element.width - stripLeft;
  const cropWidth = Math.round(style.naturalWidth * .16);
  const lower = Math.round(style.naturalHeight * .76);
  context.fillStyle = "#f4f0eb";
  context.fillRect(0, 0, element.width, element.height);
  drawImage(context, subject, subjectWidth, element.height, "contain");
  // Use the outer and lower edges of the preset portrait for color and wardrobe.
  context.drawImage(style, 0, 0, cropWidth, style.naturalHeight, stripLeft, 0, stripWidth / 2, 632);
  context.drawImage(style, style.naturalWidth - cropWidth, 0, cropWidth, style.naturalHeight,
    stripLeft + stripWidth / 2, 0, stripWidth / 2, 632);
  context.drawImage(style, 0, lower, style.naturalWidth, style.naturalHeight - lower,
    stripLeft, 640, stripWidth, element.height - 640);
  return encode(element);
}

export async function removeStudioGreenScreen(blob: Blob) {
  const source = URL.createObjectURL(blob);
  try {
    const image = await readImage(source);
    const { element, context } = canvas(image.naturalWidth, image.naturalHeight);
    drawImage(context, image, element.width, element.height, "contain");
    const pixels = context.getImageData(0, 0, element.width, element.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const [red, green, blue] = [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]];
      if (green >= 110 && green - Math.max(red, blue) >= 48) pixels.data[i + 3] = 0;
    }
    context.putImageData(pixels, 0, 0);
    return await encode(element);
  } finally {
    URL.revokeObjectURL(source);
  }
}

export async function applyStudioSubjectMask(source: string, mask: Blob) {
  const maskUrl = URL.createObjectURL(mask);
  try {
    const [photo, matte] = await Promise.all([readImage(source), readImage(maskUrl)]);
    const side = 1024;
    const frame = canvas(side, side);
    drawImage(frame.context, matte, side, side, "contain");
    const scale = Math.min(side / photo.naturalWidth, side / photo.naturalHeight);
    const width = Math.max(1, Math.round(photo.naturalWidth * scale));
    const height = Math.max(1, Math.round(photo.naturalHeight * scale));
    const { element, context } = canvas(width, height);
    context.drawImage(photo, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    const mattePixels = frame.context.getImageData(Math.floor((side - width) / 2), Math.floor((side - height) / 2), width, height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const luminance = (mattePixels.data[i] + mattePixels.data[i + 1] + mattePixels.data[i + 2]) / 3;
      pixels.data[i + 3] = Math.round(pixels.data[i + 3] * luminance / 255);
    }
    context.putImageData(pixels, 0, 0);
    return await encode(element);
  } finally {
    URL.revokeObjectURL(maskUrl);
  }
}

export async function splitStudioSheet(source: string, captions: readonly string[], language: Language) {
  const image = await readImage(source);
  if (image.naturalWidth < 250 || image.naturalHeight < 200) throw new Error("Sticker sheet too small");
  const { columns, rows } = studioStickerLayout(captions.length);
  const { naturalWidth: width, naturalHeight: height } = image;
  const { context } = canvas(width, height);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;
  const cells = studioStickerCells(pixels, width, height, columns, rows, captions.length);
  return Promise.all(captions.map((caption, index) => {
    const cell = cells[index];
    return studioStickerCrossesSeam(pixels, width, height, cell) ? null : renderStickerCell(image, cell, caption, language);
  }));
}

export function saveStudioFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
