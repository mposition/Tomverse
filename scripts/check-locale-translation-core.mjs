// Which product strings are still English in a locale that is not English.
//
// The locales are complete by key: every one carries all 1,370 of them, and a
// missing key would fail loudly at build time. What does not fail is a key
// whose *value* is still the English sentence, because that is a perfectly
// valid string -- it just is not a translation.
//
// That is how the whole account-data-export UI shipped in English to five
// locales: the block was added as `accountDataExport: { ...en.accountDataExport }`,
// a placeholder meaning "English until somebody translates it", and nothing
// ever asked whether somebody had. Korean was translated; German, Spanish,
// French, Portuguese and Chinese were not, and the surface in question is the
// one where a person downloads everything the product holds about them.
//
// So the rule is value-level, not key-level, and it is stated as: a non-English
// locale may not repeat an English sentence unless the repetition is a decision
// somebody wrote down.
//
// Deliberately narrow, because the alternative to a narrow rule here is a noisy
// one that gets ignored:
//
//   * short strings and single words are skipped. "OK", "Pro", "PDF" and
//     "{count}" are the same everywhere and saying so 400 times teaches
//     nothing;
//   * the allowlist below carries a reason per entry, and a reason is the point
//     -- an entry without one is indistinguishable from an untranslated string
//     somebody silenced.

/** Below this, a shared string is coincidence rather than a missing translation. */
export const MIN_TRANSLATABLE_LENGTH = 13;

/**
 * Strings a locale is allowed to leave in English, and why.
 *
 * `locales: "all"` means every non-English locale; a list means only those.
 * Anything not listed here must differ from English.
 */
export const SHARED_STRING_ALLOWLIST = [
  {
    key: "chat.imageModelViaGateway",
    locales: ["fr", "pt"],
    reason:
      "'via' is the same Latin preposition in French and Portuguese, and is the ordinary word for it in both -- 'par' and 'através de' are respectively less precise and too long for a row subtitle that already carries a brand and a latency. German, Spanish, Korean and Chinese all differ.",
  },
  {
    key: "externalImport.guideGeminiTitle",
    locales: ["de", "es", "fr", "pt"],
    reason:
      "Two product names side by side: Google does not translate either 'Gemini' or 'Google Takeout' in these locales, and the user has to match the string against what Google's own page says. Korean and Chinese differ only in their bracket glyphs.",
  },
  {
    key: "sidebar.title",
    locales: "all",
    reason: "The product name. Tomverse Insight is not translated anywhere.",
  },
  {
    key: "chat.toolsDeepResearch",
    locales: "all",
    reason:
      "Deep Research is the feature's name, used untranslated in the UI and in the model catalogue.",
  },
  {
    key: "chat.toolsAssistantRevision",
    locales: ["de"],
    reason:
      "German uses the same word: \"Revision {revision}\" is the translation, not the English left in place.",
  },
  {
    key: "chat.deepResearchChipLabel",
    locales: "all",
    reason: "Same feature name as chat.toolsDeepResearch.",
  },
  {
    key: "chat.searchStatusDeepResearch",
    locales: "all",
    reason: "Same feature name as chat.toolsDeepResearch.",
  },
  {
    key: "feedback.messageCounter",
    locales: ["de", "es", "fr", "pt", "zh"],
    reason:
      "A bare '{count} / {max}' counter with no words in it. Korean appends its own unit (자); the Latin-script locales and Chinese render the numbers alone.",
  },
  {
    key: "chat.googleDriveDescription",
    locales: ["fr"],
    reason:
      "Docs, Sheets and Slides are Google's product names, which French keeps as-is.",
  },
  {
    key: "chat.aiReviewContradictions",
    locales: ["fr"],
    reason: "'Contradictions' is the French word as well.",
  },
  {
    key: "assistantProfiles.historyEntry",
    locales: ["de"],
    reason:
      "'Revision' is the German word too, and the rest of the string is the number. The other locales translate it (révision, revisión, revisão, 修订, 개정).",
  },
  {
    key: "externalImport.messagesCount",
    locales: ["fr"],
    reason: "'{count} messages' is identical in French.",
  },
  {
    key: "externalImport.historyConversations",
    locales: ["fr"],
    reason: "'{count} conversations' is identical in French.",
  },
  {
    key: "memoryExtraction.conversationMeta",
    locales: ["fr"],
    reason: "'{messages} messages · {size}' is identical in French.",
  },
];

/** `{ "a.b": value }` for a nested locale object. */
export const flattenLocale = (value, prefix = "") =>
  Object.entries(value).flatMap(([key, entry]) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? flattenLocale(entry, `${prefix}${key}.`)
      : [[`${prefix}${key}`, entry]]
  );

const allows = (allowlist, key, locale) =>
  allowlist.some(
    (entry) =>
      entry.key === key &&
      (entry.locales === "all" || entry.locales.includes(locale))
  );

/**
 * @param english flattened English strings
 * @param locales `{ [locale]: flattened strings }`, English excluded
 */
export const findUntranslatedStrings = ({
  english,
  locales,
  allowlist = SHARED_STRING_ALLOWLIST,
  minLength = MIN_TRANSLATABLE_LENGTH,
}) => {
  const problems = [];
  for (const [locale, strings] of Object.entries(locales)) {
    for (const [key, source] of Object.entries(english)) {
      if (typeof source !== "string") continue;
      if (source.length < minLength) continue;
      // A single word carries no sentence structure to translate, and the ones
      // that matter (product names) are allowlisted anyway.
      if (!/\s/.test(source)) continue;
      if (strings[key] !== source) continue;
      if (allows(allowlist, key, locale)) continue;
      problems.push({ locale, key, value: source });
    }
  }
  return problems;
};

/**
 * Allowlist entries that no longer describe anything.
 *
 * Reported separately and as a failure, because a stale entry is how the rule
 * quietly stops covering a key: somebody translates the string, the entry stays,
 * and the next English regression on that key is silently permitted.
 */
export const findStaleAllowlistEntries = ({
  english,
  locales,
  allowlist = SHARED_STRING_ALLOWLIST,
}) => {
  const stale = [];
  for (const entry of allowlist) {
    if (!entry.reason || entry.reason.trim() === "") {
      stale.push({ ...entry, problem: "no reason given" });
      continue;
    }
    const source = english[entry.key];
    if (typeof source !== "string") {
      stale.push({ ...entry, problem: "no such English string" });
      continue;
    }
    const covered =
      entry.locales === "all" ? Object.keys(locales) : entry.locales;
    const stillShared = covered.filter(
      (locale) => locales[locale]?.[entry.key] === source
    );
    if (stillShared.length === 0) {
      stale.push({ ...entry, problem: "every listed locale now differs" });
    }
  }
  return stale;
};
