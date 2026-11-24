import assert from "node:assert/strict";
import { test } from "node:test";
import { fillStudioStickerCaptions, findStudioTool, STUDIO_EXPORT_FORMATS, STUDIO_PHOTO_PRESETS, STUDIO_STICKER_KEYS, STUDIO_TOOLS, STUDIO_STICKER_LIMIT, studioStickerCrop, studioStickerLayout } from "../lib/studioTools.ts";
import { parseStudioAnalysis } from "../lib/studioCreativeAnalysis.ts";
import { studioCreativeCopy } from "../locales/studioCreative.ts";

test("Studio lists the new creative tools in Everyday creations and isolates poster publishing", () => {
  assert.equal(new Set(STUDIO_TOOLS.map(tool => tool.id)).size, STUDIO_TOOLS.length);
  for (const id of ["face-analysis", "character-maker", "color-analysis"]) assert.equal(findStudioTool(id)?.group, "play");
  for (const id of ["roleplay", "character-quiz"]) assert.equal(findStudioTool(id), undefined);
  assert.deepEqual(STUDIO_TOOLS.filter(tool => tool.group === "publishing").map(tool => tool.id), ["poster"]);
  for (const { tool } of STUDIO_PHOTO_PRESETS) assert.equal(findStudioTool(tool)?.group, "design");
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
import { studioCopy, studioOutputLanguage, studioStickerSuggestions } from "../locales/studio.ts";

test("Every supported language includes Studio labels, examples, and twenty sticker captions", () => {
  const keys = Object.keys(studioCopy.en).sort();
  for (const lang of SUPPORTED_LANGUAGES) {
    assert.deepEqual(Object.keys(studioCopy[lang]).sort(), keys);
    const messages = { ...studioCopy[lang], ...studioCreativeCopy[lang] };
    assert.ok(Object.values(messages).every(value => value.trim().length > 0));
    for (const tool of STUDIO_TOOLS) {
      assert.ok(messages[tool.title]);
      assert.ok(messages[tool.description]);
    }
    for (const preset of STUDIO_PHOTO_PRESETS) assert.ok(messages[preset.label]);
    assert.equal(STUDIO_STICKER_KEYS.map(key => messages[key]).length, 20);
    assert.ok(studioOutputLanguage[lang]);
  }
  assert.notEqual(studioCopy.zh.playGroup, studioCopy["zh-Hant"].playGroup);
});

test("Studio renders only schema-checked, bounded analysis data", () => {
  assert.equal(parseStudioAnalysis("face-analysis", '{"status":"retry"}'), null);
  const feature = { color: "#889977", name: "Olive", region: [.2, .3, .4, .1] };
  const color = {
    status: "ok", season: "Soft autumn", summary: "Soft colors", features: { hair: feature, eyes: feature, skin: feature },
    profile: {
      undertone: { name: "Warm", color: "#dda88c" },
      contrast: { name: "Medium", colors: ["#665550", "#d6baa2"] },
      tone: { name: "Soft", colors: ["#bc855c", "#b6a791", "#657650", "#37505b"] },
    },
    recommended: Array(6).fill({ color: "#889977", name: "Olive" }),
    comparison: Array(6).fill({ color: "#6464cc", name: "Periwinkle" }),
    recommendedPalette: Array(10).fill("#889977"), comparisonPalette: Array(10).fill("#6464cc"), garment: null,
  };
  assert.deepEqual(parseStudioAnalysis("color-analysis", JSON.stringify(color)), color);
  assert.throws(() => parseStudioAnalysis("color-analysis", JSON.stringify({
    ...color, comparison: Array(6).fill({ color: "url(example)", name: "Invalid" }),
  })));
  assert.throws(() => parseStudioAnalysis("face-analysis", '{"status":"ok","score":11}'));
  const metric = { score: 7.9, label: "Eyes" };
  const face = {
    status: "ok", score: 7.9, summary: "Soft lighting",
    metrics: Array(11).fill(metric), observations: Array(6).fill({ ...metric, note: "Clear detail", region: null }),
    tips: Array(8).fill({ label: "Lighting", note: "Face a window" }),
    guides: { axis: .5, thirds: [.2, .35, .5, .7], markers: [{ label: "Eyes", point: [.6, .35] }] },
  };
  assert.deepEqual(parseStudioAnalysis("face-analysis", JSON.stringify(face)), face);
  assert.equal(parseStudioAnalysis("face-analysis", JSON.stringify({ ...face, guides: { ...face.guides, thirds: [.35, .2, .5, .7] } })).guides, null);
});

test("Random sticker captions fill every supported language to twenty while preserving custom text", () => {
  for (const lang of SUPPORTED_LANGUAGES) {
    const pool = [...STUDIO_STICKER_KEYS.map(key => studioCopy[lang][key]), ...studioStickerSuggestions[lang]];
    const manual = ["My own phrase", pool[0]];
    const filled = fillStudioStickerCaptions(manual, pool, () => 0);
    const alternate = fillStudioStickerCaptions(manual, pool, () => .99);
    assert.equal(filled.length, 20);
    assert.equal(new Set(filled).size, 20);
    assert.deepEqual(filled.slice(0, 2), manual);
    assert.ok(filled.slice(2).every(caption => pool.includes(caption)));
    assert.notDeepEqual(filled.slice(2).sort(), alternate.slice(2).sort());
    assert.deepEqual(fillStudioStickerCaptions(filled, pool), filled);
  }
});

test("Sticker sheets keep each requested caption in one cell for any pack size", () => {
  for (let count = 1; count <= STUDIO_STICKER_LIMIT; count++) {
    const { columns, rows } = studioStickerLayout(count);
    assert.ok(columns * rows >= count);
    const cells = Array.from({ length: count }, (_, i) => studioStickerCrop(i, 1537, 1023, columns, rows));
    assert.equal(cells.length, count);
    for (const { left, top, width, height } of cells) {
      assert.ok(width > 0 && height > 0 && left + width <= 1537 && top + height <= 1023);
    }
    assert.equal(new Set(cells.map(({ left, top }) => [left, top].join(","))).size, count);
  }
  assert.deepEqual(studioStickerLayout(1), { columns: 1, rows: 1 });
  assert.deepEqual(studioStickerLayout(20), { columns: 5, rows: 4 });
});
