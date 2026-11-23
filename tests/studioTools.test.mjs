import assert from "node:assert/strict";
import { test } from "node:test";
import { findStudioTool, STUDIO_EXPORT_FORMATS, STUDIO_STICKER_KEYS, STUDIO_TOOLS, studioStickerCrop } from "../lib/studioTools.ts";

test("The Studio directory exposes eight distinct tools with stable detail routes", () => {
  assert.equal(STUDIO_TOOLS.length, 8);
  assert.equal(new Set(STUDIO_TOOLS.map(tool => tool.id)).size, 8);
  assert.equal(STUDIO_TOOLS.filter(tool => tool.group === "play").length, 4);
  assert.equal(STUDIO_TOOLS.filter(tool => tool.group === "design").length, 4);
  for (const tool of STUDIO_TOOLS) assert.equal(findStudioTool(tool.id), tool);
  assert.equal(findStudioTool("unknown-tool"), undefined);
});

test("Twenty sticker crops tile even a non-divisible sheet without overlaps or lost pixels", () => {
  const width = 1023;
  const height = 1025;
  const crops = STUDIO_STICKER_KEYS.map((_, index) => studioStickerCrop(index, width, height));
  assert.equal(crops.length, 20);
  assert.equal(crops.reduce((area, crop) => area + crop.width * crop.height, 0), width * height);
  for (const [index, crop] of crops.entries()) {
    assert.ok(crop.width > 0 && crop.height > 0);
    if (index % 5 === 4) assert.equal(crop.left + crop.width, width);
    else assert.equal(crop.left + crop.width, crops[index + 1].left);
    if (index >= 15) assert.equal(crop.top + crop.height, height);
    else assert.equal(crop.top + crop.height, crops[index + 5].top);
  }
});

test("Poster and social exports retain their designed output ratios", () => {
  assert.deepEqual(STUDIO_EXPORT_FORMATS.map(({ width, height }) => width / height), [4 / 5, 1, 9 / 16]);
});


import { SUPPORTED_LANGUAGES } from "../lib/language.ts";
import { studioCopy, studioOutputLanguage } from "../locales/studio.ts";

test("Every supported language includes Studio labels, examples, and twenty sticker captions", () => {
  const keys = Object.keys(studioCopy.en).sort();
  for (const lang of SUPPORTED_LANGUAGES) {
    const messages = studioCopy[lang];
    assert.deepEqual(Object.keys(messages).sort(), keys);
    assert.ok(Object.values(messages).every(value => value.trim().length > 0));
    for (const tool of STUDIO_TOOLS) {
      assert.ok(messages[tool.title]);
      assert.ok(messages[tool.description]);
    }
    assert.equal(STUDIO_STICKER_KEYS.map(key => messages[key]).length, 20);
    assert.ok(studioOutputLanguage[lang]);
  }
  assert.notEqual(studioCopy.zh.playGroup, studioCopy["zh-Hant"].playGroup);
});
