import assert from "node:assert/strict";
import test from "node:test";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";
import { zh } from "../locales/zh.ts";
import { fr } from "../locales/fr.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { pt } from "../locales/pt.ts";

// STG-F007: the metric measures how much of the reviewer's quoted text can be
// matched back to the answer it was attributed to. Its user-facing name and
// explanation have to say that, in every locale that ships them.

const authoredLocales = { en, ko };
const fallbackLocales = { zh, fr, de, es, pt };

const requiredKeys = [
  "aiReviewSourceGrounding",
  "aiReviewSourceGroundingOverall",
  "aiReviewSourceGroundingUnavailable",
  "aiReviewSourceGroundingQuotesMatched",
  "aiReviewSourceGroundingInfoLabel",
  "aiReviewSourceGroundingDescription",
  "aiReviewSourceGroundingScopeReview",
  "aiReviewSourceGroundingScopeSummary",
  "aiReviewSourceGroundingLevelLow",
  "aiReviewSourceGroundingLevelMedium",
  "aiReviewSourceGroundingLevelHigh",
  "aiReviewAgreementSourceGroundingMatch",
  "aiReviewAgreementSourceGroundingMismatch",
];

// Every string a user could read the old way. Kept as an explicit list so a
// reintroduced label fails here rather than in a screenshot review.
const retiredKeys = [
  "aiReviewConfidence",
  "aiReviewGroundingHint",
  "aiReviewQuotesVerified",
  "aiReviewAgreementConfidenceMatch",
  "aiReviewAgreementConfidenceMismatch",
];

test("both authored locales ship the full source grounding vocabulary", () => {
  for (const [name, dictionary] of Object.entries(authoredLocales)) {
    for (const key of requiredKeys) {
      const value = dictionary.chat[key];
      assert.equal(
        typeof value,
        "string",
        `${name}.chat.${key} is missing`
      );
      assert.ok(value.trim().length > 0, `${name}.chat.${key} is empty`);
    }
  }
});

test("the explanation rules out accuracy, source quality and model certainty", () => {
  assert.match(
    en.chat.aiReviewSourceGroundingDescription,
    /directly matched to the linked sources/
  );
  assert.match(
    en.chat.aiReviewSourceGroundingDescription,
    /does not measure factual accuracy, source reliability, or model confidence/
  );

  assert.match(ko.chat.aiReviewSourceGroundingDescription, /직접 일치하는 정도/);
  for (const excluded of ["사실 정확도", "출처의 신뢰성", "모델의 확신"]) {
    assert.ok(
      ko.chat.aiReviewSourceGroundingDescription.includes(excluded),
      `the Korean description must rule out ${excluded}`
    );
  }
});

test("the metric name states its scope and never promises a verdict", () => {
  assert.match(en.chat.aiReviewSourceGroundingOverall, /^Overall source grounding$/);
  assert.equal(ko.chat.aiReviewSourceGroundingOverall, "전체 출처 일치도");

  // A missing measurement is named, not rendered as a score.
  assert.equal(en.chat.aiReviewSourceGroundingUnavailable, "Not available");
  assert.equal(ko.chat.aiReviewSourceGroundingUnavailable, "측정 불가");

  for (const [name, dictionary] of Object.entries(authoredLocales)) {
    for (const key of requiredKeys) {
      const value = dictionary.chat[key];
      for (const verdict of ["verified", "accurate", "trustworthy", "검증됨", "정확함", "신뢰할 수 있"]) {
        assert.ok(
          !value.toLowerCase().includes(verdict.toLowerCase()),
          `${name}.chat.${key} implies a verdict with "${verdict}"`
        );
      }
    }
  }
});

test("the placeholder counts survive translation", () => {
  for (const [name, dictionary] of Object.entries(authoredLocales)) {
    const template = dictionary.chat.aiReviewSourceGroundingQuotesMatched;
    assert.ok(template.includes("{matched}"), `${name} lost {matched}`);
    assert.ok(template.includes("{total}"), `${name} lost {total}`);

    const mismatch = dictionary.chat.aiReviewAgreementSourceGroundingMismatch;
    assert.ok(mismatch.includes("{primary}"), `${name} lost {primary}`);
    assert.ok(mismatch.includes("{secondary}"), `${name} lost {secondary}`);
  }
});

test("no locale still exposes the metric as confidence", () => {
  const allLocales = { ...authoredLocales, ...fallbackLocales };
  for (const [name, dictionary] of Object.entries(allLocales)) {
    for (const key of retiredKeys) {
      assert.equal(
        dictionary.chat?.[key],
        undefined,
        `${name}.chat.${key} was reintroduced`
      );
    }
  }
});

test("every shipped language resolves the full vocabulary, directly or by fallback", () => {
  // Mirrors LanguageProvider: an unauthored key falls back to English. Some
  // locales spread `...en.chat`, zh relies on the runtime fallback -- either
  // way no language may end up with a half-renamed metric.
  const resolve = (dictionary, key) => dictionary.chat?.[key] ?? en.chat[key];

  for (const [name, dictionary] of Object.entries({
    ...authoredLocales,
    ...fallbackLocales,
  })) {
    for (const key of requiredKeys) {
      const value = resolve(dictionary, key);
      assert.equal(typeof value, "string", `${name} cannot resolve ${key}`);
      assert.ok(value.trim().length > 0, `${name} resolves ${key} to an empty string`);
    }
    assert.ok(
      resolve(dictionary, "aiReviewSourceGroundingDescription").length > 40,
      `${name} resolves the explanation to something too short to explain anything`
    );
  }
});
