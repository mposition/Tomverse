import { studioStickerCrop, studioStickerLayout } from "@/lib/studioTools";

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
  options: { width: number; height: number; fit?: "contain" | "cover"; title?: string; subtitle?: string; sticker?: boolean },
): Promise<Blob> {
  const { width, height, fit = "cover", title, subtitle, sticker } = options;
  const image = await readImage(source);
  const { element, context } = canvas(width, height);
  drawImage(context, image, width, sticker ? height * .83 : height, fit);
  if (title) {
    const size = Math.round(width * (sticker ? .079 : .054));
    context.font = `800 ${size}px system-ui, sans-serif`;
    context.textBaseline = "middle";
    const maxWidth = width * .83;
    const titleWidth = context.measureText(title).width;
    if (subtitle) context.font = `500 ${Math.round(size * .48)}px system-ui, sans-serif`;
    const measured = Math.min(Math.max(titleWidth, subtitle ? context.measureText(subtitle).width : 0), maxWidth);
    context.font = `800 ${size}px system-ui, sans-serif`;
    const padding = size * .6;
    const x = sticker ? (width - measured - padding * 2) / 2 : width * .055;
    const y = sticker ? height * .82 : height * .06;
    const labelHeight = size * (subtitle ? 2.2 : 1.37);
    context.fillStyle = sticker ? "#ffffff" : "#142820ed";
    context.beginPath();
    context.roundRect(x, y, measured + padding * 2, labelHeight, size * .38);
    context.fill();
    context.fillStyle = sticker ? "#192821" : "#ffffff";
    context.fillText(title, x + padding, y + size * .69, maxWidth);
    if (subtitle) {
      context.font = `500 ${Math.round(size * .48)}px system-ui, sans-serif`;
      context.fillText(subtitle, x + padding, y + size * 1.65, maxWidth);
    }
  }
  return encode(element);
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

export async function splitStudioSheet(source: string, count: number) {
  const image = await readImage(source);
  if (image.naturalWidth < 250 || image.naturalHeight < 200) throw new Error("Sticker sheet too small");
  const { columns, rows } = studioStickerLayout(count);
  return Promise.all(Array.from({ length: count }, (_, index) => {
    const cell = studioStickerCrop(index, image.naturalWidth, image.naturalHeight, columns, rows);
    const { element, context } = canvas(512, 512);
    const size = 512 / Math.max(cell.width, cell.height);
    const width = cell.width * size;
    const height = cell.height * size;
    context.drawImage(image, cell.left, cell.top, cell.width, cell.height, (512 - width) / 2, (512 - height) / 2, width, height);
    return encode(element);
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
