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

export async function renderStudioSticker(source: string, caption: string): Promise<Blob> {
  const image = await readImage(source);
  const { naturalWidth, naturalHeight } = image;
  const sourceScale = Math.min(1, 512 / Math.max(naturalWidth, naturalHeight));
  const sourceWidth = Math.max(1, Math.round(naturalWidth * sourceScale));
  const sourceHeight = Math.max(1, Math.round(naturalHeight * sourceScale));
  const original = canvas(sourceWidth, sourceHeight);
  original.context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
  const pixels = original.context.getImageData(0, 0, sourceWidth, sourceHeight).data;
  let left = sourceWidth, right = -1, top = sourceHeight, bottom = -1;
  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < sourceWidth; x++) {
      if (pixels[(y * sourceWidth + x) * 4 + 3] < 32) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left) return encode(canvas(1, 1).element);

  const width = right - left + 1;
  const height = bottom - top + 1;
  const padding = Math.max(1, Math.round(Math.max(width, height) * .025));
  const outputScale = Math.min(1, 512 / (Math.max(width, height) + 2 * padding));
  const output = canvas(Math.ceil((width + 2 * padding) * outputScale), Math.ceil((height + 2 * padding) * outputScale));
  const { context } = output;
  context.scale(outputScale, outputScale);
  context.drawImage(original.element, left, top, width, height, padding, padding, width, height);
  if (caption) {
    // The prompt reserves the lower front of the artwork for exact local text.
    const centerY = Math.round(height * .73);
    const fontSize = Math.max(1, Math.round(Math.min(width * .19, height * .16)));
    let luminance = 0, samples = 0;
    for (let y = Math.max(0, Math.floor(centerY - fontSize / 2)); y <= Math.min(height - 1, centerY + fontSize / 2); y += 3) {
      for (let x = Math.floor(width * .25); x <= Math.floor(width * .75); x += 3) {
        const offset = ((top + y) * sourceWidth + left + x) * 4;
        if (pixels[offset + 3] < 192) continue;
        luminance += pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722;
        samples++;
      }
    }
    context.font = `800 ${fontSize}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = samples && luminance / samples > 145 ? "#192821" : "#fff5d8";
    context.globalCompositeOperation = "source-atop";
    context.fillText(caption, padding + width / 2, padding + centerY, width * .82);
  }
  return encode(output.element);
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
