import { studioStickerBounds, studioStickerCaptionSlot, studioStickerCells, studioStickerCrossesSeam, type StickerRect } from "@/lib/studioStickerGeometry";
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

function stickerCaption(
  context: CanvasRenderingContext2D, pixels: Uint8ClampedArray, stride: number, art: StickerRect, text: string,
) {
  const font = "system-ui, sans-serif";
  context.font = `750 100px ${font}`;
  const layout = (lines: string[]) => {
    const bandHeight = Math.max(2, Math.round(art.height * (lines.length === 1 ? .20 : .29)));
    const slot = studioStickerCaptionSlot(pixels, stride, art, bandHeight);
    if (!slot) return null;
    const widest = Math.max(...lines.map(line => context.measureText(line).width), 1) / 100;
    const size = Math.min(slot.height / (lines.length * 1.2), slot.width * .86 / widest, art.width * .175);
    return { lines, slot, size };
  };
  const oneLine = layout([text]);
  const twoLines = text.length > 6 ? layout(splitCaption(text)) : null;
  const chosen = twoLines && twoLines.size > (oneLine?.size ?? 0) * 1.16 ? twoLines : oneLine;
  if (!chosen || chosen.size < art.height * .063) return null;

  const { slot } = chosen;
  let luminance = 0, samples = 0;
  for (let y = slot.top; y < slot.top + slot.height; y += 3) {
    for (let x = slot.left; x < slot.left + slot.width; x += 3) {
      const index = (y * stride + x) * 4;
      luminance += pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722;
      samples++;
    }
  }
  return { ...chosen, font, ink: luminance / samples > 145 ? "#231e27" : "#fff8ef" };
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
  const outputScale = 512 / (Math.max(width, height) + 2 * padding);
  const output = canvas(Math.round((width + 2 * padding) * outputScale), Math.round((height + 2 * padding) * outputScale));
  const { context } = output;
  context.scale(outputScale, outputScale);
  context.drawImage(original.element, left, top, width, height, padding, padding, width, height);
  const text = caption.trim();
  if (text) {
    const label = stickerCaption(context, pixels, sourceWidth, art, text);
    if (!label) return null;
    const { lines, slot, size, font, ink } = label;
    context.font = `750 ${size}px ${font}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = ink;
    lines.forEach((line, index) => context.fillText(
      line,
      padding + slot.left - left + slot.width / 2,
      padding + slot.top - top + slot.height / 2 + (index - (lines.length - 1) / 2) * size * 1.15,
    ));
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
