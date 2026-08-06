import assert from "node:assert/strict";
import test from "node:test";
import { readImageDimensions } from "../lib/imageDimensions.ts";

// The dimensions recorded on a generation come from the file's own header,
// because the request cannot tell you: each provider translates a resolution
// tier its own way and Google's 1K landscape is not 1536x1024. Getting this
// wrong is quiet -- a transposed pair reports every landscape as portrait and
// nothing else notices.

const png = (width, height) => {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

const jpeg = (width, height) => {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt16BE(0xffd8, 0);
  bytes.writeUInt16BE(0xffc0, 2); // SOF0
  bytes.writeUInt16BE(11, 4); // segment length
  bytes.writeUInt8(8, 6); // precision
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
};

const webpVp8x = (width, height) => {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
};

test("PNG dimensions come out of the IHDR chunk", () => {
  assert.deepEqual(readImageDimensions(png(1024, 1024), "image/png"), {
    width: 1024,
    height: 1024,
  });
  assert.deepEqual(readImageDimensions(png(1536, 1024), "image/png"), {
    width: 1536,
    height: 1024,
  });
});

test("JPEG height precedes width, and is not transposed", () => {
  // The one detail a hand-written SOF parser gets wrong. A landscape read as
  // portrait would be recorded, displayed and compared as portrait.
  assert.deepEqual(readImageDimensions(jpeg(1536, 1024), "image/jpeg"), {
    width: 1536,
    height: 1024,
  });
  assert.deepEqual(readImageDimensions(jpeg(1024, 1536), "image/jpeg"), {
    width: 1024,
    height: 1536,
  });
});

test("WebP VP8X stores each dimension minus one", () => {
  assert.deepEqual(readImageDimensions(webpVp8x(2048, 1024), "image/webp"), {
    width: 2048,
    height: 1024,
  });
});

test("the MIME picks the parser, and the parser re-checks the container", () => {
  // A provider that mislabels its own output must not produce dimensions read
  // at the wrong offsets: that is worse than recording none, because it looks
  // like an answer.
  assert.equal(readImageDimensions(png(1024, 1024), "image/jpeg"), null);
  assert.equal(readImageDimensions(jpeg(1024, 1024), "image/png"), null);
  assert.equal(readImageDimensions(webpVp8x(1024, 1024), "image/png"), null);
});

test("an unsupported or truncated container reads as absent, never guessed", () => {
  assert.equal(readImageDimensions(Buffer.alloc(0), "image/png"), null);
  assert.equal(readImageDimensions(png(1024, 1024).subarray(0, 16), "image/png"), null);
  assert.equal(readImageDimensions(Buffer.from("GIF89a"), "image/gif"), null);
  assert.equal(readImageDimensions(png(1024, 1024), "application/octet-stream"), null);
});

test("a header that decodes to an impossible size is refused", () => {
  // Zero means the offsets were misread, not that the image is zero wide.
  assert.equal(readImageDimensions(png(0, 1024), "image/png"), null);
  assert.equal(readImageDimensions(png(1024, 0), "image/png"), null);
  assert.equal(readImageDimensions(png(80_000, 1024), "image/png"), null);
});
