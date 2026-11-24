import {
  studioStickerBounds, studioStickerCaptionOutside, studioStickerCaptionSlot, studioStickerCells, studioStickerCrossesSeam, type StickerRect,
} from "@/lib/studioStickerGeometry";
import { studioStickerLayout } from "@/lib/studioTools";

export const studioImageTypes = ["image/png", "image/jpeg", "image/webp"];
export const studioImageAccept = studioImageTypes.join(",");
export const studioImageLimit = 12 * 1024 * 1024;

export function validStudioImage(file: File) {
  return studioImageTypes.includes(file.type) && file.size > 0 && file.size <= studioImageLimit;
}

function canvas(width: number, height: number) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const context = element.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas unavailable");
  return { element, context };
}

function readImage(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = source;
  return image.decode().then(() => image);
}

function encode(element: HTMLCanvasElement): Promise<Blob> {
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
  options: { width: number; height: number; fit?: "contain" | "cover"; title?: string; subtitle?: string },
): Promise<Blob> {
  const { width, height, fit = "cover", title, subtitle } = options;
  const image = await readImage(source);
  const { element, context } = canvas(width, height);
  drawImage(context, image, width, height, fit);
  if (title) {
    const size = Math.round(width * .054);
    context.font = `800 ${size}px system-ui, sans-serif`;
    context.textBaseline = "middle";
    const maxWidth = width * .83;
    const titleWidth = context.measureText(title).width;
    if (subtitle) context.font = `500 ${Math.round(size * .48)}px system-ui, sans-serif`;
    const measured = Math.min(Math.max(titleWidth, subtitle ? context.measureText(subtitle).width : 0), maxWidth);
    context.font = `800 ${size}px system-ui, sans-serif`;
    const padding = size * .6;
    const x = width * .055;
    const y = height * .06;
    const labelHeight = size * (subtitle ? 2.2 : 1.37);
    context.fillStyle = "#142820ed";
    context.beginPath();
    context.roundRect(x, y, measured + padding * 2, labelHeight, size * .38);
    context.fill();
    context.fillStyle = "#ffffff";
    context.fillText(title, x + padding, y + size * .69, maxWidth);
    if (subtitle) {
      context.font = `500 ${Math.round(size * .48)}px system-ui, sans-serif`;
      context.fillText(subtitle, x + padding, y + size * 1.65, maxWidth);
    }
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

const stickerFont = "system-ui, sans-serif";
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
) {
  const shortSide = Math.min(art.width, art.height);
  const maxSize = shortSide * .18;
  context.font = `750 100px ${stickerFont}`;
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

async function renderStickerCell(image: HTMLImageElement, cell: StickerRect, caption: string): Promise<Blob | null> {
  const sourceScale = Math.min(1, 512 / Math.max(cell.width, cell.height));
  const sourceWidth = Math.max(1, Math.round(cell.width * sourceScale));
  const sourceHeight = Math.max(1, Math.round(cell.height * sourceScale));
  const original = canvas(sourceWidth, sourceHeight);
  original.context.drawImage(image, cell.left, cell.top, cell.width, cell.height, 0, 0, sourceWidth, sourceHeight);
  const pixels = original.context.getImageData(0, 0, sourceWidth, sourceHeight).data;
  const art = studioStickerBounds(pixels, sourceWidth, sourceHeight);
  if (!art || art.width < sourceWidth * .19 || art.height < sourceHeight * .19) return null;
  const { left, top, width, height } = art;
  const padding = Math.max(1, Math.round(Math.max(width, height) * .025));
  const text = caption.trim();
  const label = text ? stickerCaption(original.context, pixels, sourceWidth, art, text) : null;
  const minX = Math.min(left, label?.left ?? left) - padding;
  const minY = Math.min(top, label?.top ?? top) - padding;
  const outputWidth = Math.max(left + width, label ? label.left + label.width : 0) + padding - minX;
  const outputHeight = Math.max(top + height, label ? label.top + label.height : 0) + padding - minY;
  const outputScale = 512 / Math.max(outputWidth, outputHeight);
  const output = canvas(Math.round(outputWidth * outputScale), Math.round(outputHeight * outputScale));
  const { context } = output;
  context.scale(outputScale, outputScale);
  context.drawImage(original.element, left, top, width, height, left - minX, top - minY, width, height);
  if (label) {
    const { lines, size, ink, edge } = label;
    context.font = `750 ${size}px ${stickerFont}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = ink;
    context.strokeStyle = edge;
    context.lineWidth = size * .105;
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

export async function renderStudioSticker(source: string, caption: string): Promise<Blob | null> {
  const image = await readImage(source);
  return renderStickerCell(image, { left: 0, top: 0, width: image.naturalWidth, height: image.naturalHeight }, caption);
}

export async function makeStudioImageReference(source: string, secondSource?: string) {
  const image = await readImage(source);
  if (!secondSource) {
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const { element, context } = canvas(width, height);
    drawImage(context, image, width, height, "contain");
    return encode(element);
  }
  const second = await readImage(secondSource);
  const { element, context } = canvas(1024, 512);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 1024, 512);
  drawImage(context, image, 512, 512, "contain");
  context.translate(512, 0);
  drawImage(context, second, 512, 512, "contain");
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

export async function splitStudioSheet(source: string, captions: readonly string[]) {
  const image = await readImage(source);
  if (image.naturalWidth < 250 || image.naturalHeight < 200) throw new Error("Sticker sheet too small");
  const { columns, rows } = studioStickerLayout(captions.length);
  const { naturalWidth: width, naturalHeight: height } = image;
  const { context } = canvas(width, height);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;
  const cells = studioStickerCells(pixels, width, height, columns, rows);
  return Promise.all(captions.map((caption, index) => {
    const cell = cells[index];
    return studioStickerCrossesSeam(pixels, width, height, cell) ? null : renderStickerCell(image, cell, caption);
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
