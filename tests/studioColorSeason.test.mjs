import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";
import {
  STUDIO_COLOR_CRITERIA, STUDIO_SEASON_CONTRAST, STUDIO_SEASON_PALETTES, studioCheekBoxes, studioColorVerdict, studioLab, studioSkinColor,
} from "../lib/studioColorSeason.ts";
import { parseStudioAnalysis, studioAnalysisPrompt, studioColorReport } from "../lib/studioCreativeAnalysis.ts";
import { studioCopy } from "../locales/studio.ts";
import { studioCreativeCopy } from "../locales/studioCreative.ts";

const skinOf = (r, g, b) => ({ rgb: [r, g, b], lab: studioLab(r, g, b), hex: "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("") });
const rgba = pixels => Uint8ClampedArray.from(pixels.flatMap(([r, g, b]) => [r, g, b, 255]));

test("the cheeks sit inside the face box and their colour ignores highlight, shadow and hair", () => {
  // Brows to chin, cheek edge to cheek edge: one box each side of the nose, between the eyes and the mouth.
  const face = [.3, .25, .4, .5];
  const [left, right] = studioCheekBoxes(face);
  for (const [x, y, width, height] of [left, right]) {
    assert.ok(x >= face[0] && x + width <= face[0] + face[2] && y >= face[1] + face[3] * .35 && y + height <= face[1] + face[3] * .75);
  }
  assert.ok(left[0] + left[2] < face[0] + face[2] * .4 && right[0] > face[0] + face[2] * .6);
  // Seen from the default model on 2026-11-26: the same face boxed from the brows in one answer and from the
  // hairline in the next, with the eyes and the chin in the same place. The cheeks do not move.
  const eyes = [.6, .403, .029, .025];
  const [fromBrows, fromHairline] = [[.417, .375, .303, .215], [.417, .279, .303, .311]].map(box => studioCheekBoxes(box, eyes));
  for (const side of [0, 1]) for (const i of [0, 1, 2, 3]) assert.ok(Math.abs(fromBrows[side][i] - fromHairline[side][i]) < 1e-9);
  // Eyes that were not located, or lie outside the box, fall back to the box's own shares.
  assert.deepEqual(studioCheekBoxes(face, null), studioCheekBoxes(face, [.4, .9, .05, .03]));
  // Mirror images of each other about the face's centre line.
  assert.ok(Math.abs((left[0] - face[0]) - (face[0] + face[2] - right[0] - right[2])) < 1e-9);
  assert.deepEqual(studioLab(255, 255, 255).map(v => Math.round(v) + 0), [100, 0, 0]);
  assert.deepEqual(studioLab(0, 0, 0).map(v => Math.round(v) + 0), [0, 0, 0]);
  const cheek = Array(60).fill([205, 160, 140]);
  const plain = studioSkinColor(rgba(cheek));
  assert.equal(plain.hex, "#cda08c");
  // A fifth of the box is a highlight and another fifth is hair: the reading does not move.
  const busy = studioSkinColor(rgba([...cheek, ...Array(20).fill([252, 250, 248]), ...Array(20).fill([24, 22, 26])]));
  assert.deepEqual(busy.rgb, plain.rgb);
  // A third of the box in shadow or stubble does not darken it either: the reading comes from the lit skin.
  const shaded = studioSkinColor(rgba([...cheek, ...Array(30).fill([120, 88, 76])]));
  assert.deepEqual(shaded.rgb, plain.rgb);
  assert.equal(studioSkinColor(rgba(Array(8).fill([205, 160, 140]))), null);
  assert.equal(studioSkinColor(Uint8ClampedArray.from(Array(40).fill([205, 160, 140, 0]).flat())), null);
});

test("one measurement gives one type, and a nearby measurement gives the same one", () => {
  // The two cheek colours measured on 2026-11-26, each from four different model answers (CIELAB).
  const idPhoto = [[71.8, 14.9, 15.4], [72.6, 14.6, 15.2], [72.0, 15.0, 15.1], [71.5, 14.8, 15.6]];
  const selfie = [[72.8, 11.5, 15.1], [73.5, 11.6, 14.7], [71.9, 12.0, 15.1], [72.4, 11.3, 15.3]];
  const verdicts = labs => labs.map(lab => studioColorVerdict({ lab, rgb: [205, 160, 140] }));
  for (const [runs, undertone] of [[idPhoto, "warm"], [selfie, "cool"]]) {
    const sides = new Set(verdicts(runs).map(verdict => verdict.axes.undertone.side + " " + verdict.axes.lightness.side));
    assert.deepEqual([...sides], [undertone + " light"]);
  }
  // The two photos are told apart, and neither undertone is called clear from a single photo this close to the cut.
  assert.notEqual(verdicts(idPhoto)[0].type.season, verdicts(selfie)[0].type.season);
  assert.ok(verdicts(selfie).every(verdict => verdict.axes.undertone.confidence !== "clear"));
});

test("each axis carries a confidence and the second type differs on the least certain axis", () => {
  const { undertone, lightness } = STUDIO_COLOR_CRITERIA;
  // b* that puts the discriminant a given distance above its cut, at a* = 11.
  const withDistance = distance => (distance + undertone.cut - undertone.offset - undertone.a * 11) / undertone.b;
  const at = (distance, L = lightness.cut + 10) => studioColorVerdict({ lab: [L, 11, withDistance(distance)], rgb: [200, 160, 150] });
  assert.equal(at(undertone.spread * 1.5).axes.undertone.confidence, "clear");
  assert.equal(at(undertone.spread * .6).axes.undertone.confidence, "leaning");
  assert.equal(at(undertone.spread * .1).axes.undertone.confidence, "undecided");
  assert.equal(at(-undertone.spread * 1.5).axes.undertone.side, "cool");
  // Undertone is the weakest axis here, so the second type is the same tone on the other side of it.
  const leaning = at(undertone.spread * .6);
  assert.equal(leaning.alternative.undertone, "cool");
  assert.equal(leaning.alternative.tone === leaning.type.tone || leaning.alternative.season !== leaning.type.season, true);
  // With the undertone clear and the lightness on its cut, the second type differs in lightness instead.
  const onTheLine = at(undertone.spread * 3, lightness.cut + .2);
  assert.equal(onTheLine.axes.lightness.confidence, "undecided");
  assert.equal(onTheLine.alternative.undertone, onTheLine.type.undertone);
  assert.notDeepEqual(onTheLine.alternative, onTheLine.type);
  // A photo whose colour cannot be trusted never yields a decided undertone or saturation.
  const cast = studioColorVerdict({ lab: [75, 11, withDistance(undertone.spread * 4)], rgb: [200, 160, 150] }, true);
  assert.deepEqual([cast.axes.undertone.confidence, cast.axes.saturation.confidence], ["undecided", "undecided"]);
  assert.equal(cast.axes.lightness.confidence, "clear");
});

test("the eight types follow the published table", () => {
  const { undertone, lightness } = STUDIO_COLOR_CRITERIA;
  const b = warm => ((warm ? 3 : -3) + undertone.cut - undertone.offset - undertone.a * 11) / undertone.b;
  const expected = {
    "true true true": "spring bright", "true true false": "spring light", "true false true": "autumn deep", "true false false": "autumn mute",
    "false true true": "winter bright", "false true false": "summer light", "false false true": "winter deep", "false false false": "summer mute",
  };
  for (const warm of [true, false]) for (const light of [true, false]) for (const vivid of [true, false]) {
    const { type } = studioColorVerdict({ lab: [lightness.cut + (light ? 8 : -8), 11, b(warm)], rgb: vivid ? [220, 130, 100] : [200, 170, 160] });
    assert.equal(type.season + " " + type.tone, expected[[warm, light, vivid].join(" ")]);
    assert.equal(type.undertone, warm ? "warm" : "cool");
  }
});

test("a colour report is built from the measurement in every language, with the season's own palette", () => {
  const observation = parseStudioAnalysis("color-analysis", JSON.stringify({
    status: "ok", summary: "Soft window light", face: [.3, .25, .4, .5], garment: [[0, .8], [.5, .9], [1, .8], [1, 1], [0, 1]], unreliable: false,
    features: { hair: { color: "#1b1a1b", name: "Black", region: [.2, .05, .5, .2] }, eyes: { color: "#3a2620", name: "Brown", region: [.38, .38, .05, .03] },
      skin: { name: "Light beige" } },
  }));
  for (const lang of SUPPORTED_LANGUAGES) {
    const words = { ...studioCopy[lang], ...studioCreativeCopy[lang] };
    const report = studioColorReport(observation, skinOf(205, 160, 140), words);
    // The skin swatch is the measured colour, not the one the model wrote.
    assert.equal(report.features.skin.color, "#cda08c");
    assert.deepEqual(report.features.skin.region, studioCheekBoxes([.3, .25, .4, .5], [.38, .38, .05, .03])[0]);
    assert.equal(report.profile.undertone.color, "#cda08c");
    assert.deepEqual(report.profile.contrast.colors, ["#cda08c", "#1b1a1b"]);
    for (const text of [report.season, report.alternative, report.profile.undertone.name, report.profile.contrast.name, report.profile.tone.name]) {
      assert.ok(text.includes(" · ") && !text.includes("undefined"), lang + ": " + text);
    }
    assert.notEqual(report.season, report.alternative);
    assert.equal(report.recommended.length, 6);
    assert.equal(report.comparison.length, 6);
    assert.equal(new Set(report.recommendedPalette).size, 10);
    assert.equal(new Set(report.comparisonPalette).size, 10);
    for (const item of [...report.recommended, ...report.comparison]) assert.ok(item.name?.trim() && /^#[0-9a-f]{6}$/.test(item.color), lang);
  }
  // Cheeks lit differently leave the undertone undecided, whatever the measurement says.
  const ko = { ...studioCopy.ko, ...studioCreativeCopy.ko };
  assert.ok(studioColorReport(observation, skinOf(225, 150, 100), ko, true).profile.undertone.name.endsWith(ko.colorConfidenceUndecided));
  assert.ok(!studioColorReport(observation, skinOf(225, 150, 100), ko).profile.undertone.name.endsWith(ko.colorConfidenceUndecided));
  // Same measurement, same report: nothing in it comes from a second judgement.
  const words = { ...studioCopy.ko, ...studioCreativeCopy.ko };
  assert.deepEqual(studioColorReport(observation, skinOf(205, 160, 140), words), studioColorReport(observation, skinOf(205, 160, 140), words));
  for (const [season, palette] of Object.entries(STUDIO_SEASON_PALETTES)) {
    assert.equal(palette.named.length, 6);
    assert.equal(palette.more.length, 4);
    assert.notEqual(STUDIO_SEASON_CONTRAST[season], season);
  }
});

test("the colour prompt asks the model to observe and locate, not to decide", () => {
  const prompt = studioAnalysisPrompt("color-analysis", "Korean");
  assert.match(prompt, /do not name a seasonal type, an undertone or recommended colours/);
  assert.match(prompt, /exactly these keys: status, summary, face, features, garment, unreliable/);
  assert.match(prompt, /a tight box from the eyebrows down to the chin/);
  assert.doesNotMatch(prompt, /Spring = warm and clear|recommendedPalette/);
});
