import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fillStudioStickerCaptions, findStudioTool, studioObjectUrl, STUDIO_EXPORT_FORMATS, STUDIO_PHOTO_PRESETS, STUDIO_STICKER_KEYS, STUDIO_TOOLS, STUDIO_STICKER_LIMIT, studioStickerCrop, studioStickerLayout } from "../lib/studioTools.ts";
import { parseStudioAnalysis, studioAnalysisPrompt, studioReportCrop } from "../lib/studioCreativeAnalysis.ts";
import { studioCreativeCopy } from "../locales/studioCreative.ts";
import { STUDIO_PHOTO_CATEGORIES, studioPresetName, studioPublicationPresets } from "../lib/studioPresetLibrary.ts";
import {
  STUDIO_SOCIAL_FORMATS, studioOrderedSocialPresets,
  STUDIO_PUBLISHING_MIN_KEPT, studioPublishingDesign, studioPublishingPrompt, studioPublishingTrim, studioSocialFormat,
} from "../lib/studioPublishing.ts";

test("Studio lists the new creative tools in Everyday creations and isolates poster publishing", () => {
  assert.equal(new Set(STUDIO_TOOLS.map(tool => tool.id)).size, STUDIO_TOOLS.length);
  for (const id of ["face-analysis", "character-maker", "color-analysis"]) assert.equal(findStudioTool(id)?.group, "play");
  for (const id of ["roleplay", "character-quiz"]) assert.equal(findStudioTool(id), undefined);
  assert.deepEqual(STUDIO_TOOLS.filter(tool => tool.group === "publishing").map(tool => tool.id), ["poster", "social-post"]);
  for (const { tool } of STUDIO_PHOTO_PRESETS) assert.equal(findStudioTool(tool)?.group, "design");
  for (const tool of STUDIO_TOOLS) assert.equal(findStudioTool(tool.id), tool);
  assert.equal(findStudioTool("unknown-tool"), undefined);
});

test("Studio libraries expose a unique visual for each localized preset", () => {
  const publishing = [...studioPublicationPresets("poster"), ...studioPublicationPresets("social-post")];
  assert.equal(STUDIO_PHOTO_PRESETS.length, 102);
  assert.equal(STUDIO_PHOTO_CATEGORIES.length, 8);
  assert.equal(studioPublicationPresets("poster").length, 16);
  assert.equal(studioPublicationPresets("social-post").length, 28);
  const all = [...STUDIO_PHOTO_PRESETS, ...publishing];
  assert.equal(new Set(all.map(preset => preset.artwork)).size, all.length);
  assert.equal(new Set(STUDIO_PHOTO_PRESETS.map(preset => preset.id)).size, STUDIO_PHOTO_PRESETS.length);
  for (const preset of all) {
    assert.ok(existsSync(new URL("../public/studio/" + preset.artwork, import.meta.url)), preset.artwork);
    for (const lang of SUPPORTED_LANGUAGES) assert.ok(studioPresetName(preset, lang)?.trim(), preset.id + " " + lang);
  }
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

test("Poster briefs use the selected art direction and have the model set the headline once", () => {
  assert.deepEqual([STUDIO_EXPORT_FORMATS[0].width, STUDIO_EXPORT_FORMATS[0].height], [2160, 2700]);
  const posters = studioPublicationPresets("poster");
  const designs = posters.map(preset => studioPublishingDesign("poster", preset.id));
  assert.equal(new Set(designs.map(design => design.direction)).size, posters.length);
  const input = {
    kind: "poster", design: studioPublishingDesign("poster", "cafe-menu"),
    language: "Korean", brief: "여름 한정 메뉴", title: "콜드브루 \"온도\"", details: "₩6,500",
    hasPhoto: true, hasLogo: true,
  };
  const exact = studioPublishingPrompt(input);
  assert.match(exact, /Premium tabletop food photography/);
  assert.match(exact, /Use the reference as the featured subject/);
  // A supplied headline reaches the model as the literal text to set; the canvas never sets it again.
  assert.ok(exact.includes('Set this exact headline once, character for character, in its own script: "콜드브루 \\"온도\\"".'));
  assert.equal(exact.split("콜드브루").length - 1, 1);
  assert.match(exact, /Keep the bottom 22% free of typography/);
  // The canvas places the details, so their text stays out of the prompt and cannot be drawn twice.
  assert.doesNotMatch(exact, /6,500/);
  assert.doesNotMatch(exact, /No letters/);
  const story = studioPublishingPrompt({ ...input, kind: "social-post", placement: studioSocialFormat("instagram-story") });
  assert.match(story, /Keep the bottom 35% free of typography/);
  const automatic = studioPublishingPrompt({ ...input, title: "", details: "", hasPhoto: false, hasLogo: false });
  assert.match(automatic, /Write one short headline in Korean based on the brief/);
  assert.match(automatic, /Continue the artwork to the frame edges/);
  assert.match(automatic, /never a photograph or mockup of a poster/);
  assert.doesNotMatch(automatic, /Keep the bottom/);
  assert.doesNotMatch(automatic, /Use the reference as the featured subject/);
  assert.match(automatic, /Do not invent ratings, reviews, quotes, statistics, hashtags, small print, dates, prices/);
});

test("A design drawn in a nearby shape fills its placement, and the model is told what is trimmed", () => {
  const tall = { width: 1024, height: 1536 }, wide = { width: 1536, height: 1024 }, square = { width: 1024, height: 1024 };
  assert.equal(studioPublishingTrim(tall, studioSocialFormat("pinterest-pin")), null);
  assert.equal(studioPublishingTrim(square, studioSocialFormat("instagram-square")), null);
  for (const [drawn, id, sides, percent] of [
    [tall, "instagram-feed", "top and bottom", 8], [tall, "instagram-tall", "top and bottom", 6], [tall, "instagram-story", "left and right", 8],
    [wide, "youtube-thumbnail", "top and bottom", 8], [wide, "linkedin-landscape", "top and bottom", 11],
  ]) {
    const trim = studioPublishingTrim(drawn, studioSocialFormat(id));
    assert.deepEqual([trim.sides, Math.round(trim.each * 100), trim.fills], [sides, percent, true], id);
  }
  // A square drawn for a story or a wide banner would lose too much: it is shown whole instead.
  assert.equal(studioPublishingTrim(square, studioSocialFormat("instagram-story")).fills, false);
  assert.equal(studioPublishingTrim(square, studioSocialFormat("x-feed")).fills, false);
  assert.ok(STUDIO_PUBLISHING_MIN_KEPT <= studioPublishingTrim(wide, studioSocialFormat("linkedin-landscape")).kept);

  const input = {
    kind: "social-post", design: studioPublishingDesign("social-post", "travel-story"), language: "Korean",
    brief: "제주 여행", title: "제주 3박 4일", details: "@tomverse", hasPhoto: false, hasLogo: false,
  };
  const story = studioPublishingPrompt({ ...input, placement: studioSocialFormat("instagram-story"), drawn: tall, finished: studioSocialFormat("instagram-story") });
  assert.match(story, /trimmed to 9:16: 8% is cut off each of the left and right edges/);
  assert.match(story, /Keep the bottom 35% free of typography/);
  assert.doesNotMatch(story, /central safe area/);
  // Trimmed from the bottom, the footer band is counted on the taller image the model draws.
  const feed = studioPublishingPrompt({ ...input, placement: studioSocialFormat("instagram-feed"), drawn: tall, finished: studioSocialFormat("instagram-feed") });
  assert.match(feed, /trimmed to 4:5: 8% is cut off each of the top and bottom edges/);
  assert.match(feed, /Keep the bottom 28% free of typography/);
  const poster = studioPublishingPrompt({ ...input, kind: "poster", design: studioPublishingDesign("poster", "cafe-menu"), drawn: tall, finished: STUDIO_EXPORT_FORMATS[0] });
  assert.match(poster, /trimmed to 4:5: 8% is cut off each of the top and bottom edges/);
  assert.match(poster, /Keep the bottom 27% free of typography/);
  const fallback = studioPublishingPrompt({ ...input, placement: studioSocialFormat("instagram-story"), drawn: square, finished: studioSocialFormat("instagram-story") });
  assert.match(fallback, /Compose for a 9:16 placement/);
  assert.doesNotMatch(fallback, /trimmed to/);
});

test("Social placements have their own dimensions, safe areas and recommended styles", () => {
  assert.equal(new Set(STUDIO_SOCIAL_FORMATS.map(format => format.id)).size, 16);
  assert.equal(new Set(STUDIO_SOCIAL_FORMATS.map(format => format.platform)).size, 8);
  for (const format of STUDIO_SOCIAL_FORMATS) {
    const [w, h] = format.ratio.split(":").map(Number);
    assert.ok(Math.abs(format.width / format.height - w / h) < .005);
    for (const lang of SUPPORTED_LANGUAGES) assert.ok((studioCreativeCopy[lang][format.label] ?? studioCopy[lang][format.label])?.trim());
  }
  assert.deepEqual(studioSocialFormat("instagram-story").safe, studioSocialFormat("facebook-story").safe);
  assert.ok(studioSocialFormat("tiktok-photo").safe[2] > studioSocialFormat("instagram-story").safe[2]);
  assert.equal(studioSocialFormat(undefined, 1).id, "instagram-square");
  assert.equal(studioSocialFormat(undefined, 2).id, "instagram-story");
  assert.equal(studioOrderedSocialPresets("YouTube")[0].id, "creator-reaction");
  assert.equal(studioOrderedSocialPresets("Instagram")[0].id, "photo-dump");
  assert.equal(studioOrderedSocialPresets("Pinterest")[0].id, "inspiration-pin");
  for (const preset of studioPublicationPresets("social-post")) {
    assert.ok(studioPublishingDesign("social-post", preset.id).direction.includes(preset.direction));
  }
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
    for (const preset of STUDIO_PHOTO_PRESETS) assert.ok(studioPresetName(preset, lang));
    assert.equal(STUDIO_STICKER_KEYS.map(key => messages[key]).length, 20);
    assert.ok(studioOutputLanguage[lang]);
  }
  assert.notEqual(studioCopy.zh.playGroup, studioCopy["zh-Hant"].playGroup);
});

test("A report card shows the whole named area instead of the middle of a wide one", () => {
  const image = { width: 880, height: 1168 }, card = { width: 160, height: 121 };
  const within = (inner, outer) => outer[0] <= inner[0] + 1e-9 && outer[1] <= inner[1] + 1e-9 &&
    outer[0] + outer[2] >= inner[0] + inner[2] - 1e-9 && outer[1] + outer[3] >= inner[1] + inner[3] - 1e-9;
  for (const region of [[.30, .355, .41, .08], [.42, .40, .17, .13], [.215, .41, .58, .12], [.16, .025, .69, .26], [.0, .0, 1, .05], [.9, .2, .1, .7]]) {
    const crop = studioReportCrop(region, image, card);
    // Both eyes stay in an eye card, and the crop has the card's shape and stays on the photo.
    assert.ok(within(region, crop), JSON.stringify(region));
    assert.ok(Math.abs(image.width * crop[2] / (image.height * crop[3]) - card.width / card.height) < .01 || crop[2] === 1 || crop[3] === 1);
    assert.ok(crop[0] >= 0 && crop[1] >= 0 && crop[0] + crop[2] <= 1 + 1e-9 && crop[1] + crop[3] <= 1 + 1e-9);
  }
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
  const partial = { ...face, metrics: face.metrics.slice(0, 10), observations: face.observations.slice(0, 5), tips: face.tips.slice(0, 7) };
  const fencedAnswer = "Here is the analysis.\n```json\n" + JSON.stringify(partial) + "\n```";
  assert.deepEqual(parseStudioAnalysis("face-analysis", fencedAnswer), partial);
  assert.throws(() => parseStudioAnalysis("face-analysis", JSON.stringify({ ...partial, metrics: [] })));
  assert.equal(parseStudioAnalysis("face-analysis", JSON.stringify({ ...face, guides: { ...face.guides, thirds: [.35, .2, .5, .7] } })).guides, null);
});

test("Analysis answers in the shapes the model really returns are read, and the overall score is the metrics' mean", () => {
  // Seen from the default model on 2026-11-26: named objects in a hex palette, a one-iris region a few
  // percent across, and an overall score that is not the mean of its own metrics.
  const feature = { color: "#1b1a1b", name: "Black", region: [.385, .38, .045, .026] };
  const named = Array.from({ length: 10 }, (_, i) => ({ color: "#a64b3" + i, name: "Shade " + i }));
  const color = parseStudioAnalysis("color-analysis", JSON.stringify({
    status: "ok", season: "Autumn", summary: "Warm skin", features: { hair: feature, eyes: feature, skin: feature },
    profile: { undertone: { name: "Warm", color: "#dda88c" }, contrast: { name: "High", colors: ["#1b1a1b", "#d6baa2"] },
      tone: { name: "Muted", colors: ["#bc855c", "#b6a791", "#657650", "#37505b"] } },
    recommended: named.slice(0, 6), comparison: named.slice(0, 6), recommendedPalette: named, comparisonPalette: named.map(item => item.color), garment: null,
  }));
  assert.deepEqual(color.recommendedPalette, named.map(item => item.color));
  assert.deepEqual(color.features.eyes.region, [.385, .38, .045, .026]);
  // The card widens a tiny area before showing it, and keeps the iris inside.
  const crop = studioReportCrop(color.features.eyes.region, { width: 772, height: 1024 }, { width: 200, height: 99 });
  assert.ok(crop[2] >= .14 && crop[0] <= .385 && crop[0] + crop[2] >= .43 && crop[1] <= .38 && crop[1] + crop[3] >= .406);
  const scores = [7, 7.5, 7.5, 7, 7, 7, 7, 7, 8, 8, 7.5];
  const face = parseStudioAnalysis("face-analysis", JSON.stringify({
    status: "ok", score: 6.7, summary: "Soft light",
    metrics: scores.map((score, i) => ({ label: "Metric " + i, score })),
    observations: Array(6).fill({ label: "Eyes", score: 7, note: "Clear", region: null }),
    tips: Array(8).fill({ label: "Lighting", note: "Face a window" }), guides: null,
  }));
  assert.equal(face.score, 7.3);
  for (const kind of ["face-analysis", "color-analysis"]) {
    const prompt = studioAnalysisPrompt(kind, "Korean");
    assert.match(prompt, /Return an object with exactly these keys: status, (score|season), summary/);
    assert.match(prompt, /check that every bracket and brace closes/);
  }
  // The key the model used when it was only told "the numeric overall score" is not accepted silently.
  assert.throws(() => parseStudioAnalysis("face-analysis", JSON.stringify({ status: "ok", overall: 7, summary: "x", metrics: [], observations: [], tips: [] })));
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

test("a Studio object URL is the browser's own blob URL, unchanged", () => {
  for (const url of ["blob:https://tomverse.app/7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", "blob:http://127.0.0.1:3100/0a1b2c3d", "blob:null/0a1b2c3d"]) {
    assert.equal(studioObjectUrl(url), url);
  }
  // Never a string that is not an object URL, and never a rewritten one.
  for (const url of ["javascript:alert(1)", "data:text/html,<b>x</b>", "blob:http://[::1]:3000/0a1b2c3d"]) {
    assert.throws(() => studioObjectUrl(url), /studio_object_url_unexpected/);
  }
});
