import { studioStickerCrop } from "@/lib/studioTools";

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

export async function splitStudioSheet(source: string) {
  const image = await readImage(source);
  if (image.naturalWidth < 250 || image.naturalHeight < 200) throw new Error("Sticker sheet too small");
  return Promise.all(Array.from({ length: 20 }, (_, index) => {
    const cell = studioStickerCrop(index, image.naturalWidth, image.naturalHeight);
    const { element, context } = canvas(512, 512);
    const size = 512 / Math.max(cell.width, cell.height);
    const width = cell.width * size;
    const height = cell.height * size;
    context.drawImage(image, cell.left, cell.top, cell.width, cell.height, (512 - width) / 2, (512 - height) / 2, width, height);
    return encode(element);
  }));
}

export async function removeSolidStudioBackground(source: string, tolerance: number) {
  const image = await readImage(source);
  const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const { element, context } = canvas(width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const { data } = pixels;
  const reference = [data[0], data[1], data[2]];
  const queue = new Uint32Array(width * height);
  const seen = new Uint8Array(width * height);
  let write = 0;
  const visit = (index: number) => {
    if (seen[index]) return;
    seen[index] = 1;
    const i = index * 4;
    if (data[i + 3] === 0 || reference.every((color, channel) => Math.abs(color - data[i + channel]) <= tolerance)) {
      data[i + 3] = 0;
      queue[write++] = index;
    }
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  for (let read = 0; read < write; read++) {
    const index = queue[read];
    const x = index % width;
    if (x > 0) visit(index - 1);
    if (x + 1 < width) visit(index + 1);
    if (index >= width) visit(index - width);
    if (index + width < queue.length) visit(index + width);
  }
  context.putImageData(pixels, 0, 0);
  return encode(element);
}

export function saveStudioFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
