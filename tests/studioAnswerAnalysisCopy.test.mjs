import assert from "node:assert/strict";
import test from "node:test";
import { studioAnswerAnalysisCopy } from "../lib/studioAnswerAnalysisCopy.ts";

const languages = ["en", "ko", "zh", "fr", "de", "es", "pt"];

test("the answer analysis window is translated in every supported language", () => {
  assert.deepEqual(Object.keys(studioAnswerAnalysisCopy).sort(), [...languages].sort());
  const en = studioAnswerAnalysisCopy.en;
  for (const language of languages.filter((language) => language !== "en")) {
    const copy = studioAnswerAnalysisCopy[language];
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(en).sort(), `${language} keys differ from English`);
    // A spread of the English copy hid untranslated strings on 2026-10-31: the
    // zh window showed its subtitle, summary headings and disclaimer in English.
    for (const [key, value] of Object.entries(copy)) {
      assert.notEqual(value, en[key], `${language}.${key} falls back to English`);
    }
  }
});
