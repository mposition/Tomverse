import assert from "node:assert/strict";
import { test } from "node:test";
import {
  studioStickerBounds, studioStickerCaptionOutside, studioStickerCaptionSlot, studioStickerCells, studioStickerCrossesSeam,
} from "../lib/studioStickerGeometry.ts";
import { studioStickerPrompt } from "../lib/studioStickerPrompt.ts";

function fill(data, stride, left, top, width, height) {
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) data[(y * stride + x) * 4 + 3] = 255;
  }
}

test("Studio gives every sticker an ordered pose cue while keeping original identity and text separate", () => {
  const cues = Array.from({ length: 20 }, (_, i) => "문구 " + (i + 1));
  const pack = studioStickerPrompt("real", cues);
  assert.match(pack, /fixed 5-column by 4-row grid/);
  assert.match(pack, /quoted captions are acting cues only/);
  assert.match(pack, /Preserve face shape, eye shape and spacing/);
  const rows = pack.split("\n").filter(line => /^Row \d+: /.test(line));
  assert.deepEqual(rows.flatMap(row => row.replace(/^Row \d+: /, "").split(" | ").map(value => JSON.parse(value))), cues);
  const short = studioStickerPrompt("character", cues.slice(0, 7));
  assert.match(short, /Row 3: "문구 7" \| \[empty\] \| \[empty\]/);
  assert.match(studioStickerPrompt("real", [cues[0]]), /Make one centered chat sticker/);
});

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

test("Studio keeps all stickers when adjacent rows or columns have staggered gutters", () => {
  for (const transpose of [false, true]) {
    const side = 200;
    const data = new Uint8ClampedArray(side * side * 4);
    for (const [x, y, w, h] of [[12, 12, 95, 68], [120, 12, 66, 68], [14, 112, 59, 70], [87, 112, 86, 70]]) {
      fill(data, side, ...(transpose ? [y, x, h, w] : [x, y, w, h]));
    }
    const cells = studioStickerCells(data, side, side, 2, 2);
    assert.equal(cells.length, 4);
    for (const cell of cells) {
      assert.equal(studioStickerCrossesSeam(data, side, side, cell), false);
      const art = studioStickerBounds(data, side, cell);
      assert.ok(art && art.width > 55 && art.height > 55);
    }
    assert.notEqual(transpose ? cells[2].top : cells[1].left, transpose ? cells[3].top : cells[3].left);
  }
});

test("Studio sticker bounds ignore a stray pixel and caption text fits wholly inside opaque art", () => {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  fill(data, 100, 2, 2, 1, 1);
  fill(data, 100, 33, 10, 34, 48);
  fill(data, 100, 20, 61, 60, 25);
  const art = studioStickerBounds(data, 100, { left: 0, top: 0, width: 100, height: 100 });
  assert.deepEqual(art, { left: 20, top: 10, width: 60, height: 76 });
  const caption = studioStickerCaptionSlot(data, 100, art, 13);
  assert.ok(caption && caption.top >= 61 && caption.top + caption.height <= 86);
  for (let y = caption.top; y < caption.top + caption.height; y++) {
    for (let x = caption.left; x < caption.left + caption.width; x++) assert.equal(data[(y * 100 + x) * 4 + 3], 255);
  }
  assert.equal(studioStickerCaptionSlot(data, 100, art, 36), null);
});

test("Studio tucks a caption into free space on any edge of the silhouette", () => {
  const art = { left: 0, top: 0, width: 100, height: 100 };
  const gaps = [
    { left: 30, top: 0, width: 40, height: 20 },
    { left: 80, top: 30, width: 20, height: 40 },
    { left: 30, top: 80, width: 40, height: 20 },
    { left: 0, top: 30, width: 20, height: 40 },
  ];
  for (const gap of gaps) {
    const data = new Uint8ClampedArray(100 * 100 * 4);
    fill(data, 100, 0, 0, 100, 100);
    for (let y = gap.top; y < gap.top + gap.height; y++) {
      for (let x = gap.left; x < gap.left + gap.width; x++) data[(y * 100 + x) * 4 + 3] = 0;
    }
    const label = studioStickerCaptionOutside(data, 100, art, 16, 12);
    assert.ok(label.left >= gap.left && label.left + label.width <= gap.left + gap.width);
    assert.ok(label.top >= gap.top && label.top + label.height <= gap.top + gap.height);
  }
});
