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
  // zh 191 -> 9, fr 235 -> 26, de 234 -> 20, es 230 -> 16, pt 227 -> 13.
  //
  // fr, de, es and pt each gain one on 2026-08-14: the Gemini import guide's
  // card title is "Gemini (Google Takeout)", two product names Google does not
  // translate into any of them. The user matches this string against Google's
  // own export page, so translating it would make the recipe harder to follow.
  // Allowlisted in check-locale-translation-core.mjs for the same reason.
  //
  // Chinese differs only in its bracket glyphs and Korean in its spacing, so
  // neither moved.
  //
  // The 241 strings behind those numbers were translated in one pass: the whole
  // AI Review surface, Deep Research setup and its status lines, guest import
  // and the guest-save prompts, the comparison rail, the web-search chips, and
  // every screen of the model finder. `...en.chat` and `...en.modelFinder` stay
  // as the structural fallback -- they are what keeps a key from ever going
  // missing -- but nothing reaches a reader through them any more.
  //
  // What is left in each locale is one of three things, and each was checked
  // rather than assumed: a product name Tomverse does not translate anywhere
  // ("Tomverse Insight", "Deep Research"), a format string with no words in it
  // ("{count} / {max}"), or a true cognate. Cognates are per-locale, which is
  // why these five numbers differ: French keeps "Portrait", "Sources", "Auto"
  // and "{count} messages"; German keeps "Standard", "Status" and "Feedback";
  // Spanish keeps "Plan", "Personal" and "General". None of them is English
  // copy sitting in front of a reader.
  // +3: the image workspace's imageGenerationRestoreExcluded,
  // imageGenerationRestoreOptionsUnavailable and
  // imageGenerationGeneratingModels, which zh takes from en wholesale like the
  // rest of that surface. The other five locales carry real translations of
  // all three, so only this number moves.
  //
  // -21 from all five (accountDataExport): the account-data download surface is
  // translated. It was flagged here rather than buried because it is privacy
  // copy -- a step-up sign-in, a link that works once, and a history whose
  // "Refused" row means someone presented a link for this account and was
  // turned away. Reading that in a second language is a worse experience than
  // an untranslated picker label, so it went first.
  //
  // +1 fr and +2 de from the assistant profile screens (release C): French
  // spells "Description" the same way English does, and German spells both
  // "Name" and "Revision" the same way. All three were checked against the
  // rest of that block, which is translated -- they are cognates, not copy
  // that got skipped.
  //
  // +1 fr again from the conversation's assistant picker (release C4):
  // French spells "Assistant" the same way English does, and German spells
  // "Revision {revision}" the same way -- the same cognate the translation
  // check allowlists for chat.toolsAssistantRevision. The rest of that block
  // -- the "no assistant" option, the superseded line and the empty state --
  // is translated in both.
  //
  // +1 fr and +1 pt from the image catalogue's gateway line
  // (chat.imageModelViaGateway). "via" is the same Latin preposition in both,
  // and the ordinary word for it: "par" is less precise and "atraves de" is
  // too long for a subtitle already carrying a brand and a latency class.
  // German, Spanish, Korean and Chinese all differ, so only these two moved.
  // Allowlisted in check-locale-translation-core.mjs for the same reason.
  //
  // +1 de from the assistant profile create form (release C): German writes
  // the optional marker as "(optional)", which is the ordinary word and not a
  // skipped translation -- "(freiwillig)" means voluntary and "(wahlweise)"
  // reads as a choice between alternatives, neither of which is what a form
  // field marker says. French, Spanish, Portuguese and Chinese all differ, so
  // only German moved.
  //
  // +1 for fr and de on 2026-08-21: the preference centre's newsletter row is
  // titled "Newsletter", which is the word French and German both use for it.
  // Rendering something else would be a worse translation, not a better one.
  // Chinese, Spanish and Portuguese have their own words and did not move.
  zh: 10,
  fr: 31,
  de: 26,
  es: 17,
  pt: 15,
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
