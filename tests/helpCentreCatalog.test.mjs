import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { HELP_CATEGORIES, HELP_GUIDES } from "../lib/helpCentre/catalog.ts";
import { HELP_COPY } from "../lib/helpCentre/copy/index.ts";
import { HELP_CATEGORY_IDS } from "../lib/helpCentre/types.ts";

const languages = ["ko", "en", "zh", "zh-Hant", "fr", "de", "es", "pt"];

test("every guide id is unique and every category has guides", () => {
  const ids = HELP_GUIDES.map((guide) => guide.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(HELP_CATEGORIES.map((category) => category.id), [...HELP_CATEGORY_IDS]);
  for (const category of HELP_CATEGORY_IDS) {
    assert.ok(HELP_GUIDES.some((guide) => guide.category === category), `${category} has no guide`);
  }
  for (const guide of HELP_GUIDES) assert.match(guide.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("every locale has every guide with the catalogue's step count", () => {
  assert.deepEqual(Object.keys(HELP_COPY).sort(), [...languages].sort());
  for (const language of languages) {
    const copy = HELP_COPY[language];
    assert.deepEqual(Object.keys(copy.guides).sort(), HELP_GUIDES.map((guide) => guide.id).sort(), `${language} guide ids`);
    assert.deepEqual(Object.keys(copy.categories).sort(), [...HELP_CATEGORY_IDS].sort(), `${language} category ids`);
    assert.deepEqual(Object.keys(copy.ui).sort(), Object.keys(HELP_COPY.ko.ui).sort(), `${language} ui keys`);
    assert.equal(copy.ui.suggestions.length, HELP_COPY.ko.ui.suggestions.length, `${language} suggestions`);
    for (const guide of HELP_GUIDES) {
      const words = copy.guides[guide.id];
      assert.equal(words.steps.length, guide.steps.length, `${language} ${guide.id} step count`);
      assert.ok(words.title.trim() && words.summary.trim(), `${language} ${guide.id} title/summary`);
      for (const step of words.steps) assert.ok(step.title.trim() && step.body.trim(), `${language} ${guide.id} empty step`);
      for (const item of words.faq) assert.ok(item.q.trim() && item.a.trim(), `${language} ${guide.id} empty faq`);
      assert.equal(words.faq.length, HELP_COPY.ko.guides[guide.id].faq.length, `${language} ${guide.id} faq count`);
    }
  }
});

test("every screenshot a step names was captured, with a measured highlight", () => {
  const hotspots = JSON.parse(readFileSync(new URL("../lib/helpCentre/shots.json", import.meta.url), "utf8"));
  const keys = new Set(HELP_GUIDES.flatMap((guide) => guide.steps.map((step) => step.shot).filter(Boolean)));
  assert.ok(keys.size > 0, "no guide step shows a screenshot");
  for (const key of keys) {
    assert.ok(hotspots[key], `${key} has no measured highlight`);
    for (const lang of ["ko", "en"]) {
      assert.ok(existsSync(new URL(`../public/help/shots/${lang}/${key}.webp`, import.meta.url)), `${lang}/${key}.webp missing`);
    }
  }
});

test("placeholders survive translation", () => {
  for (const language of languages) {
    const ui = HELP_COPY[language].ui;
    assert.match(ui.guideCount, /\{count\}/, `${language} guideCount`);
    assert.match(ui.foundIn, /\{count\}/, `${language} foundIn`);
    assert.match(ui.stepLabel, /\{n\}/, `${language} stepLabel`);
    assert.match(ui.stepsAndMinutes, /\{steps\}/, `${language} stepsAndMinutes steps`);
    assert.match(ui.stepsAndMinutes, /\{minutes\}/, `${language} stepsAndMinutes minutes`);
  }
});

test("non-English locales are not English copies", () => {
  for (const language of languages.filter((entry) => entry !== "en")) {
    const copy = HELP_COPY[language];
    let same = 0;
    for (const guide of HELP_GUIDES) if (copy.guides[guide.id].summary === HELP_COPY.en.guides[guide.id].summary) same += 1;
    assert.equal(same, 0, `${language} has ${same} guide summaries identical to English`);
  }
});
