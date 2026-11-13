// The ink grid of a real capture (creative-kit/geometry.js reads it): for each
// 8x8 source pixel cell, whether the picture changes sharply there down a
// column (bit 1: a glyph's top or bottom, a rule) or along a row (bit 2: a
// glyph's side, a border). Light card borders and shadows stay under the
// threshold; text does not. Written by render-creative.mjs before each render
// so the kit can keep a crop's edges in the gaps between lines and words.
import { CELL } from "./creative-kit/geometry.js";
import { probe, ffmpegBytes } from "./ffmpeg-tools.mjs";

/** A change of more than this (0-255 gray) between neighbouring pixels is an edge. */
const EDGE = 40;

/** The grid of a gray picture (one byte per pixel, row-major). */
export function gridOf(gray, width, height) {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const bytes = new Uint8Array(Math.ceil((cols * rows * 2) / 8));
  const mark = (x, y, bit) => {
    const index = (Math.floor(y / CELL) * cols + Math.floor(x / CELL)) * 2 + (bit - 1);
    bytes[index >> 3] |= 1 << (index & 7);
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const value = gray[row + x];
      if (y > 0 && Math.abs(value - gray[row - width + x]) > EDGE) mark(x, y, 1);
      if (x > 0 && Math.abs(value - gray[row + x - 1]) > EDGE) mark(x, y, 2);
    }
  }
  return { width, height, cols, rows, bits: Buffer.from(bytes).toString("base64") };
}

/** The grid of a PNG file. */
export function gridOfFile(file) {
  const video = probe(file).streams?.find((stream) => stream.codec_type === "video");
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!(width > 0 && height > 0)) throw new Error(`${file}: not a picture`);
  const gray = ffmpegBytes(["-i", file, "-f", "image2pipe", "-c:v", "rawvideo", "-pix_fmt", "gray", "-"]);
  if (gray.length !== width * height) throw new Error(`${file}: decoded ${gray.length} bytes for ${width}x${height}`);
  return gridOf(gray, width, height);
}
