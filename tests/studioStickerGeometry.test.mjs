import assert from "node:assert/strict";
import { test } from "node:test";
import { studioStickerBounds, studioStickerCaptionSlot, studioStickerCells, studioStickerCrossesSeam } from "../lib/studioStickerGeometry.ts";

function fill(data, stride, left, top, width, height) {
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) data[(y * stride + x) * 4 + 3] = 255;
  }
}

test("Studio sticker crop follows gutters offset from the nominal center", () => {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (const top of [6, 63]) {
    fill(data, 100, 7, top, 48, 27);
    fill(data, 100, 62, top, 31, 27);
  }
  fill(data, 100, 10, 32, 39, 23);
  const [first, second, third, fourth] = studioStickerCells(data, 100, 100, 2, 2);
  assert.ok(second.left >= 55 && second.left <= 62);
  assert.ok(third.top >= 55 && third.top <= 63);
  assert.equal(first.width, second.left);
  assert.equal(first.height, third.top);
  assert.equal(fourth.left, second.left);
  assert.equal(fourth.top, third.top);
  assert.equal(studioStickerCrossesSeam(data, 100, 100, first), false);
});

test("Studio flags a tile when a seam would cut solid artwork", () => {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  fill(data, 100, 27, 7, 48, 34);
  const [first, second] = studioStickerCells(data, 100, 100, 2, 1);
  assert.equal(studioStickerCrossesSeam(data, 100, 100, first), true);
  assert.equal(studioStickerCrossesSeam(data, 100, 100, second), true);
});

test("Studio sticker bounds ignore a stray pixel and caption text fits wholly inside opaque art", () => {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  fill(data, 100, 2, 2, 1, 1);
  fill(data, 100, 33, 10, 34, 48);
  fill(data, 100, 20, 61, 60, 25);
  const art = studioStickerBounds(data, 100, 100);
  assert.deepEqual(art, { left: 20, top: 10, width: 60, height: 76 });
  const caption = studioStickerCaptionSlot(data, 100, art, 13);
  assert.ok(caption && caption.top >= 61 && caption.top + caption.height <= 86);
  for (let y = caption.top; y < caption.top + caption.height; y++) {
    for (let x = caption.left; x < caption.left + caption.width; x++) assert.equal(data[(y * 100 + x) * 4 + 3], 255);
  }
  assert.equal(studioStickerCaptionSlot(data, 100, art, 36), null);
});
