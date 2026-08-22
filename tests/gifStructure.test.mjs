import assert from "node:assert/strict";
import test from "node:test";

import {
  GifStructureError,
  isAnimatedGif,
  readGifStructure,
} from "../lib/gifStructure.ts";

/**
 * A still GIF is supported and an animated one is refused by name. That
 * distinction has to be decided from the bytes rather than from whatever page
 * count the installed libvips reports, or a safety property would depend on
 * how a native library was compiled -- so the walk is tested directly, on
 * archives built here.
 */

const header = (version) => [...Buffer.from(version, "ascii")];
// 1x1 logical screen, global colour table of two entries.
const screen = [0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00];
const globalColorTable = [0xff, 0xff, 0xff, 0x00, 0x00, 0x00];
// One 1x1 image: descriptor, LZW minimum code size, one sub-block, terminator.
const imageBlock = [
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x02, 0x4c, 0x01, 0x00,
];
// A graphic control extension, which every animation frame carries.
const graphicControl = [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00];
const trailer = [0x3b];

const gif = (frames, version = "GIF89a") =>
  Uint8Array.from([
    ...header(version),
    ...screen,
    ...globalColorTable,
    ...Array.from({ length: frames }, () => [...graphicControl, ...imageBlock]).flat(),
    ...trailer,
  ]);

test("a single-frame GIF reads as one frame", () => {
  const structure = readGifStructure(gif(1));
  assert.equal(structure.frames, 1);
  assert.equal(structure.width, 1);
  assert.equal(structure.height, 1);
  assert.equal(structure.version, "GIF89a");
  assert.equal(isAnimatedGif(gif(1)), false);
});

test("GIF87a is read as well as GIF89a", () => {
  assert.equal(readGifStructure(gif(1, "GIF87a")).version, "GIF87a");
});

test("a multi-frame GIF is reported as animated", () => {
  assert.equal(isAnimatedGif(gif(2)), true);
  assert.equal(isAnimatedGif(gif(12)), true);
  // The walk stops as soon as the answer is known rather than counting a
  // million descriptors a hostile file could supply.
  assert.equal(readGifStructure(gif(50)).frames, 2);
});

test("a GIF without a global colour table still parses", () => {
  const withoutTable = Uint8Array.from([
    ...header("GIF89a"),
    0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    ...imageBlock,
    ...trailer,
  ]);
  assert.equal(readGifStructure(withoutTable).frames, 1);
});

test("something that is not a GIF is refused, not guessed at", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
  assert.throws(() => readGifStructure(png), GifStructureError);
  assert.throws(() => readGifStructure(new Uint8Array(4)), GifStructureError);
  assert.throws(
    () => readGifStructure(Uint8Array.from(Buffer.from("GIF88a1234567", "ascii"))),
    GifStructureError
  );
});

test("a truncated GIF is refused rather than half-read", () => {
  const whole = gif(1);
  for (const cut of [10, 16, 20, whole.length - 2]) {
    assert.throws(() => readGifStructure(whole.subarray(0, cut)), GifStructureError, `cut ${cut}`);
  }
});

test("a GIF with no image block at all is refused", () => {
  const empty = Uint8Array.from([
    ...header("GIF89a"),
    ...screen,
    ...globalColorTable,
    ...trailer,
  ]);
  assert.throws(() => readGifStructure(empty), GifStructureError);
});

test("an unknown block type is refused rather than skipped", () => {
  const strange = Uint8Array.from([
    ...header("GIF89a"),
    ...screen,
    ...globalColorTable,
    0x7f,
    ...trailer,
  ]);
  assert.throws(() => readGifStructure(strange), GifStructureError);
});

test("a zero-sized logical screen is refused", () => {
  const noPixels = Uint8Array.from([
    ...header("GIF89a"),
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...imageBlock,
    ...trailer,
  ]);
  assert.throws(() => readGifStructure(noPixels), GifStructureError);
});
