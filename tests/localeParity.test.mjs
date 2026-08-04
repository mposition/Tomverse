import assert from "node:assert/strict";
import test from "node:test";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";
import { localeLaunchPolicy } from "../lib/localeLaunchPolicy.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";

/**
 * UX-020.
 *
 * Chinese had drifted 182 keys behind English -- the entire model finder and
 * most of the chat interface -- with nothing to catch it. `fr`, `de`, `es` and
 * `pt` carried `satisfies typeof en`, so a missing key was a compile error for
 * them; `ko` and `zh` did not, so for those two a key could simply stop
 * existing.
 *
 * `LanguageProvider`'s `t()` falls back to English, so the user saw English
 * rather than a raw key -- which is why this was invisible in the product and
 * had to be measured. That fallback is also what makes the fix runtime-neutral:
 * the English spreads now in `zh` render exactly what the missing keys already
 * rendered.
 *
 * These assertions are about what the *source* can express, not about
 * translation quality. Two things they hold:
 *
 *   1. Every locale is structurally complete, so a key can never go missing
 *      again in any of the seven.
 *   2. How much of each locale is still English is a recorded number. A string
 *      quietly reverting to English fails here, and translating one requires
 *      lowering the number on purpose -- which is the visible act.
 */

const dictionaries = { en, ko, zh, fr, de, es, pt };

const flatten = (value, prefix = "") =>
  Object.entries(value).flatMap(([key, entry]) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? flatten(entry, `${prefix}${key}.`)
      : [[`${prefix}${key}`, entry]]
  );

const entriesFor = (language) => new Map(flatten(dictionaries[language]));
const englishEntries = entriesFor("en");

/**
 * How many keys each locale still answers with the exact English string.
 *
 * These are ceilings, not targets: a locale may improve, and lowering a number
 * here is how a translation lands. Raising one is a regression -- either a
 * translated string was replaced with English, or a new English-only key was
 * added without the locale being considered.
 */
const ENGLISH_STRING_CEILING = {
  // Primary market locales. The handful that match English are proper nouns
  // and shared technical labels ("Max", "GPT-5.4 mini"), not untranslated copy.
  ko: 8,
  // Limited market. The chat interface and the model finder are English.
  // +1 (190 -> 191): modelFinder.saveAsDefaultHint arrived with the saved
  // new-conversation combination and zh takes modelFinder from en wholesale.
  zh: 191,
  // Preview markets, all of which spread `...en.chat` and `en.modelFinder`.
  // fr +1 (226 -> 227): modelFinder.saveAsDefaultHint, taken from en wholesale.
  // fr +2 (230 -> 232): externalImport.messagesCount and
  // .historyConversations — "{count} messages" / "{count} conversations" are
  // spelled identically in French; the section is otherwise fully translated.
  // fr +1 (232 -> 233): memoryReview.kind.structure — "Structure" is spelled
  // identically in French; the memoryReview section is otherwise fully
  // translated.
  // fr +1 (233 -> 234): chat.modelPickerTabImage — "Image" is spelled
  // identically in French; the rest of the image tab is translated.
  fr: 234,
  // de/es/pt +1 for the same saveAsDefaultHint key.
  // de +1 (233 -> 234): chat.modelPickerTabChat — "Chat" is the German word
  // too; the image tab's other strings are translated.
  de: 234,
  // es +1 (229 -> 230): chat.modelPickerTabChat — "Chat" is the Spanish word
  // too; the image tab's other strings are translated.
  es: 230,
  pt: 227,
};

test("every supported language is in the dictionary map", () => {
  assert.deepEqual(
    [...SUPPORTED_LANGUAGES].sort(),
    Object.keys(dictionaries).sort()
  );
});

test("no locale is missing a key English has", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const entries = entriesFor(language);
    const missing = [...englishEntries.keys()].filter(
      (key) => !entries.has(key)
    );
    assert.deepEqual(
      missing,
      [],
      `${language} is missing ${missing.length} key(s), starting with ${missing
        .slice(0, 5)
        .join(", ")}`
    );
  }
});

test("no locale invents a key English does not have", () => {
  // An extra key is dead weight at best; at worst it is a rename that landed in
  // one locale and nowhere else, so the other six silently fall back.
  for (const language of SUPPORTED_LANGUAGES) {
    const extra = [...entriesFor(language).keys()].filter(
      (key) => !englishEntries.has(key)
    );
    assert.deepEqual(extra, [], `${language} has keys English does not`);
  }
});

test("the amount of English left in each locale is a recorded number", () => {
  for (const [language, ceiling] of Object.entries(ENGLISH_STRING_CEILING)) {
    const entries = entriesFor(language);
    const identical = [...englishEntries].filter(
      ([key, value]) => typeof value === "string" && entries.get(key) === value
    );
    assert.ok(
      identical.length <= ceiling,
      `${language} answers ${identical.length} keys in English, above the recorded ${ceiling}. ` +
        `If a translation was replaced with English that is the regression; if new English-only ` +
        `keys were added, translate them or raise this number deliberately.`
    );
    // Also guards the other direction: a ceiling left far above reality stops
    // being a check at all.
    assert.ok(
      identical.length >= ceiling - 25,
      `${language} is now at ${identical.length}, well under its recorded ${ceiling}. ` +
        `Lower the ceiling so it keeps holding.`
    );
  }
});

test("a locale that is mostly English says so in its launch policy", () => {
  // The disclosure and the strings have to agree. Chinese used to claim it
  // "covers the product interface" while the whole chat interface answered in
  // English, which is the specific thing this pins.
  for (const language of SUPPORTED_LANGUAGES) {
    if (language === "en") continue;
    const policy = localeLaunchPolicy[language];
    const entries = entriesFor(language);
    const identical = [...englishEntries].filter(
      ([key, value]) => typeof value === "string" && entries.get(key) === value
    ).length;

    if (identical > 50) {
      assert.notEqual(
        policy.marketTier,
        "primary",
        `${language} answers ${identical} keys in English and cannot be a primary market`
      );
      assert.ok(
        policy.englishFallbackNotice,
        `${language} falls back to English ${identical} times and must disclose it`
      );
      assert.equal(
        policy.paidMarketingEligible,
        false,
        `${language} is not translated enough to be paid-marketing eligible`
      );
    }
  }
});

test("the primary markets are actually translated", () => {
  // The release-blocking half. English and Korean are what the product is sold
  // in, so neither may carry a fallback of any size.
  for (const language of SUPPORTED_LANGUAGES) {
    if (language === "en") continue;
    if (localeLaunchPolicy[language].marketTier !== "primary") continue;
    const entries = entriesFor(language);
    const identical = [...englishEntries].filter(
      ([key, value]) => typeof value === "string" && entries.get(key) === value
    ).length;
    assert.ok(
      identical <= 10,
      `${language} is a primary market but answers ${identical} keys in English`
    );
  }
});

test("the chat interface is translated in every primary market", () => {
  // Named explicitly because this is the surface Chinese lost: `chat.*` is the
  // product, not a peripheral page.
  const chatKeys = [...englishEntries.keys()].filter((key) =>
    key.startsWith("chat.")
  );
  assert.ok(chatKeys.length > 100);
  for (const language of SUPPORTED_LANGUAGES) {
    if (localeLaunchPolicy[language].marketTier !== "primary") continue;
    if (language === "en") continue;
    const entries = entriesFor(language);
    const untranslated = chatKeys.filter(
      (key) =>
        typeof englishEntries.get(key) === "string" &&
        entries.get(key) === englishEntries.get(key)
    );
    assert.ok(
      untranslated.length <= 5,
      `${language} leaves ${untranslated.length} chat strings in English`
    );
  }
});
