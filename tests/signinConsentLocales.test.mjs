import assert from "node:assert/strict";
import test from "node:test";
import { ko } from "../locales/ko.ts";
import { en } from "../locales/en.ts";
import { zh } from "../locales/zh.ts";
import { fr } from "../locales/fr.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { pt } from "../locales/pt.ts";

// UI-P2-02: the sign-in consent block (terms link, privacy link, and the
// surrounding sentence) used to hardcode English copy, which leaked into
// every locale. These keys must be defined natively for every supported
// language rather than silently relying on the LanguageProvider's English
// fallback.
const dictionaries = { ko, en, zh, fr, de, es, pt };
const CONSENT_KEYS = ["termsLink", "privacy", "privacyPolicyLink"];

test("every supported locale defines its own sign-in consent copy", () => {
  for (const [lang, dict] of Object.entries(dictionaries)) {
    for (const key of CONSENT_KEYS) {
      const value = dict.auth?.[key];
      assert.equal(
        typeof value,
        "string",
        `locales/${lang}.ts is missing auth.${key}`
      );
      assert.ok(
        value.trim().length > 0,
        `locales/${lang}.ts has an empty auth.${key}`
      );
    }
  }
});

test("non-English locales do not fall back to the English consent sentence", () => {
  for (const [lang, dict] of Object.entries(dictionaries)) {
    if (lang === "en") continue;
    assert.notEqual(
      dict.auth.privacy,
      en.auth.privacy,
      `locales/${lang}.ts auth.privacy matches English exactly -- looks like an untranslated fallback`
    );
  }
});

test("the terms link label is translated, not hardcoded English, outside of en", () => {
  for (const [lang, dict] of Object.entries(dictionaries)) {
    if (lang === "en") continue;
    assert.notEqual(
      dict.auth.termsLink,
      "Terms and Conditions",
      `locales/${lang}.ts auth.termsLink is still the hardcoded English label`
    );
  }
});

test("Korean sign-in consent copy matches the reviewed legal terminology", () => {
  assert.equal(ko.auth.termsLink, "이용약관");
  assert.equal(ko.auth.privacyPolicyLink, "개인정보 처리방침");
});

test("English sign-in consent copy uses the product's canonical terms label", () => {
  assert.equal(en.auth.termsLink, "Terms and Conditions");
  assert.equal(en.auth.privacyPolicyLink, "Privacy Policy");
});
