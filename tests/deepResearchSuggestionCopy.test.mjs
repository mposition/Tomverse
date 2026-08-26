import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";
import { zh } from "../locales/zh.ts";
import { fr } from "../locales/fr.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { pt } from "../locales/pt.ts";
import { resolveDeepResearchSuggestionCopy } from "../components/chat/deepResearchSuggestionCopy.ts";

/**
 * The expansion offer's words.
 *
 * Two things are held here that a screenshot review would not catch reliably:
 * that every shipped locale has the strings at all, and that none of them
 * describes the offer in terms of the machinery behind it.
 */

const locales = { en, ko, zh, fr, de, es, pt };

const requiredKeys = [
  "deepResearchSuggestionTitle",
  "deepResearchSuggestionDescription",
  "deepResearchSuggestionEstimate",
  "deepResearchSuggestionEstimateTimeOnly",
  "deepResearchSuggestionExpand",
  "deepResearchSuggestionDismiss",
  "deepResearchSuggestionStarting",
];

test("every shipped locale carries the whole card", () => {
  for (const [name, dictionary] of Object.entries(locales)) {
    for (const key of requiredKeys) {
      const value = dictionary.chat?.[key];
      assert.equal(typeof value, "string", `${name}.chat.${key}`);
      assert.ok(value.trim().length > 0, `${name}.chat.${key} is empty`);
    }
  }
});

test("the estimate templates name the placeholders the resolver fills", () => {
  for (const [name, dictionary] of Object.entries(locales)) {
    const full = dictionary.chat.deepResearchSuggestionEstimate;
    assert.ok(full.includes("{duration}"), `${name} full estimate duration`);
    assert.ok(full.includes("{credits}"), `${name} full estimate credits`);
    const timeOnly = dictionary.chat.deepResearchSuggestionEstimateTimeOnly;
    assert.ok(timeOnly.includes("{duration}"), `${name} time-only duration`);
    // The line that exists precisely because there is no trustworthy credit
    // figure must not smuggle one in.
    assert.ok(!timeOnly.includes("{credits}"), `${name} time-only credits`);
  }
});

/**
 * The offer is about what a second pass would add, so the copy may not talk
 * about models, re-answering or routing -- and it may not suggest the answer
 * already on screen was wrong.
 *
 * `Deep Research` is the product's own name for the feature and is allowed;
 * "deep research model", switching to one, or answering again is not.
 */
const forbiddenPhrases = [
  // Korean: the mechanism, and any hint that the answer needs redoing.
  "모델 전환",
  "모델을 전환",
  "모델 변경",
  "모델로 바꿔",
  "다시 답변",
  "재답변",
  "라우팅",
  "잘못된 답변",
  "부정확",
  "불완전",
  // English and the Latin-script locales.
  "switch model",
  "switch to the",
  "change the model",
  "answer again",
  "re-answer",
  "reanswer",
  "regenerate",
  "routing",
  "router",
  "incorrect answer",
  "inaccurate",
  "incomplete answer",
];

test("no locale describes the offer as a model switch or a re-answer", () => {
  for (const [name, dictionary] of Object.entries(locales)) {
    for (const key of requiredKeys) {
      const value = dictionary.chat[key].toLowerCase();
      for (const phrase of forbiddenPhrases) {
        assert.ok(
          !value.includes(phrase.toLowerCase()),
          `${name}.chat.${key} says "${phrase}"`
        );
      }
    }
  }
});

test("the Korean copy is the wording the product approved", () => {
  assert.equal(
    ko.chat.deepResearchSuggestionTitle,
    "더 깊은 조사가 도움이 될 수 있어요"
  );
  assert.equal(
    ko.chat.deepResearchSuggestionDescription,
    "이 주제는 여러 최신 자료를 비교하면 근거와 출처가 더 탄탄한 답변을 만들 수 있습니다."
  );
  assert.equal(ko.chat.deepResearchSuggestionExpand, "딥 리서치로 확장");
  assert.equal(ko.chat.deepResearchSuggestionDismiss, "지금 답변으로 충분해요");
});

/* ------------------------------------------------------- the resolved copy */

const translate = (dictionary) => (key) => {
  const value = key
    .split(".")
    .reduce((node, part) => (node ? node[part] : undefined), dictionary);
  assert.equal(typeof value, "string", `missing key ${key}`);
  return value;
};

test("requirement 10: the estimate quotes the shared duration phrase, never a literal", () => {
  const copy = resolveDeepResearchSuggestionCopy({
    t: translate(ko),
    estimatedCredits: 21,
  });
  // The duration is the same approved phrase the setup sheet shows, read
  // through the dictionary rather than written here.
  assert.ok(copy.estimate.includes(ko.chat.deepResearchEstimatedTimeValue));
  assert.ok(copy.estimate.includes("21"));
  assert.ok(!copy.estimate.includes("{duration}"));
  assert.ok(!copy.estimate.includes("{credits}"));
});

test("requirement 10: no credit figure is invented when none can be resolved", () => {
  const copy = resolveDeepResearchSuggestionCopy({
    t: translate(en),
    estimatedCredits: null,
  });
  assert.ok(copy.estimate.includes(en.chat.deepResearchEstimatedTimeValue));
  assert.ok(!/\d/.test(copy.estimate.replace(/\{[^}]*\}/g, "")));
  assert.ok(!copy.estimate.toLowerCase().includes("credit"));
});

test("the resolver reads every string from the dictionary", () => {
  for (const [name, dictionary] of Object.entries(locales)) {
    const copy = resolveDeepResearchSuggestionCopy({
      t: translate(dictionary),
      estimatedCredits: 12,
    });
    assert.equal(copy.title, dictionary.chat.deepResearchSuggestionTitle, name);
    assert.equal(
      copy.description,
      dictionary.chat.deepResearchSuggestionDescription,
      name
    );
    assert.equal(copy.expand, dictionary.chat.deepResearchSuggestionExpand, name);
    assert.equal(copy.dismiss, dictionary.chat.deepResearchSuggestionDismiss, name);
    assert.equal(copy.starting, dictionary.chat.deepResearchSuggestionStarting, name);
  }
});
