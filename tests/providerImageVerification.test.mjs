import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { verifyProviderImageOutput } from "../lib/imageGenerationService.ts";

// A provider's bytes are checked before the original is stored: a file that
// passes here becomes a completed, charged generation. The header alone is
// not enough -- sharp's `metadata()` happily describes a truncated PNG or
// JPEG -- so these cases are the ones a header-only check let through.

const noise = (format) =>
  sharp({
    create: {
      width: 64,
      height: 48,
      channels: 3,
      noise: { type: "gaussian", mean: 128, sigma: 30 },
    },
  })
    [format]()
    .toBuffer();

const truncate = (bytes) => bytes.subarray(0, Math.floor(bytes.length * 0.6));

const corruptTail = (bytes) => {
  const corrupted = Buffer.from(bytes);
  for (let i = Math.floor(bytes.length / 2); i < bytes.length - 4; i += 1) corrupted[i] = 0x5a;
  return corrupted;
};

for (const [format, mimeType] of [
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]) {
  test(`a complete ${format} is accepted with its signature's mime type and header dimensions`, async () => {
    const verified = await verifyProviderImageOutput(await noise(format));
    assert.deepEqual(verified, { ok: true, mimeType, dimensions: { width: 64, height: 48 } });
  });

  test(`a truncated ${format} is rejected`, async () => {
    const verified = await verifyProviderImageOutput(truncate(await noise(format)));
    assert.equal(verified.ok, false);
  });
}

test("a truncated png or jpeg whose header still parses is rejected by the decode, not the header", async () => {
  for (const format of ["png", "jpeg"]) {
    const truncated = truncate(await noise(format));
    // The premise: a header-only read would have accepted this file.
    const meta = await sharp(truncated).metadata();
    assert.equal(meta.width, 64);
    const verified = await verifyProviderImageOutput(truncated);
    assert.equal(verified.ok, false);
    assert.match(verified.reason, /^image_decode_failed/);
  }
});

test("a png or jpeg with corrupt image data is rejected", async () => {
  for (const format of ["png", "jpeg"]) {
    const verified = await verifyProviderImageOutput(corruptTail(await noise(format)));
    assert.equal(verified.ok, false);
  }
});

test("bytes without an allowed image signature are rejected before decoding", async () => {
  const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
  assert.deepEqual(await verifyProviderImageOutput(gif), {
    ok: false,
    reason: "unrecognized_image_signature",
  });
  assert.deepEqual(await verifyProviderImageOutput(Buffer.alloc(0)), {
    ok: false,
    reason: "unrecognized_image_signature",
  });
});
