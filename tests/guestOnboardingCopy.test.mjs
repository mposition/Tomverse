import assert from "node:assert/strict";
import test from "node:test";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

const translations = { en, ko, zh, fr, de, es, pt };

test("guest onboarding is complete and truthful in every supported language", () => {
  for (const [language, translation] of Object.entries(translations)) {
    const copy = translation.onboarding;
    assert.match(copy.compareBody, /3/, `${language} must state the three-model guest limit`);
    // CJK translations express the same policy with fewer characters.
    assert.ok(copy.filesBody.length > 20, `${language} must explain follow-up usage limits`);
    assert.ok(copy.privateBody.length > 30, `${language} must explain signed-in capabilities and plan limits`);
    assert.notEqual(translation.auth.login, "auth.login", `${language} must localize the sign-in CTA`);
  }
});

test("Korean and English onboarding state the actual product boundaries", () => {
  assert.match(ko.onboarding.compareBody, /최대 3개의 무료 모델/);
  assert.match(ko.onboarding.filesBody, /게스트 사용량 제한/);
  assert.match(ko.onboarding.privateBody, /플랜별 모델 및 크레딧 제한/);
  assert.doesNotMatch(ko.onboarding.privateTitle, /전체 기능/);

  assert.match(en.onboarding.compareBody, /up to 3 free models/i);
  assert.match(en.onboarding.filesBody, /guest usage limits apply/i);
  assert.match(en.onboarding.privateBody, /plan model and credit limits apply/i);
  assert.doesNotMatch(en.onboarding.privateTitle, /full workspace/i);
});
