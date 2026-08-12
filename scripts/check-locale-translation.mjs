// Fails when a non-English locale still shows an English sentence.
//
// See scripts/check-locale-translation-core.mjs for why the rule is
// value-level rather than key-level, and what it deliberately does not cover.
//
//   npm run check:locale-translation

import {
  findStaleAllowlistEntries,
  findUntranslatedStrings,
  flattenLocale,
} from "./check-locale-translation-core.mjs";

const LOCALES = ["ko", "de", "es", "fr", "pt", "zh"];

const load = async (locale) => {
  const bundle = await import(`../locales/${locale}.ts`);
  return Object.fromEntries(flattenLocale(bundle[locale]));
};

const english = await load("en");
const locales = Object.fromEntries(
  await Promise.all(
    LOCALES.map(async (locale) => [locale, await load(locale)])
  )
);

const stale = findStaleAllowlistEntries({ english, locales });
if (stale.length > 0) {
  console.error(
    `\n${stale.length} stale allowlist entr(y/ies) in ` +
      "scripts/check-locale-translation-core.mjs:\n" +
      stale
        .map((entry) => `  - ${entry.key} [${entry.problem}]`)
        .join("\n") +
      "\n\nAn entry that no longer describes anything is how the rule stops\n" +
      "covering a key: the string gets translated, the entry stays, and the\n" +
      "next English regression on that key is permitted in silence. Remove it.\n"
  );
  process.exit(1);
}

const problems = findUntranslatedStrings({ english, locales });
if (problems.length > 0) {
  const byLocale = new Map();
  for (const problem of problems) {
    if (!byLocale.has(problem.locale)) byLocale.set(problem.locale, []);
    byLocale.get(problem.locale).push(problem);
  }
  console.error(
    `\n${problems.length} string(s) still English in a non-English locale:\n` +
      [...byLocale]
        .map(
          ([locale, entries]) =>
            `  ${locale} (${entries.length}):\n` +
            entries
              .map(
                (entry) =>
                  `    - ${entry.key}: ${JSON.stringify(entry.value.slice(0, 80))}`
              )
              .join("\n")
        )
        .join("\n") +
      "\n\nEvery locale carries every key, so nothing here failed to build --\n" +
      "these keys hold the English sentence as their value. Translate them, or\n" +
      "add an entry to SHARED_STRING_ALLOWLIST with a reason if the repetition\n" +
      "is deliberate (a product name, a bare number format).\n"
  );
  process.exit(1);
}

const counted = Object.values(locales)[0] ?? {};
console.log(
  `Locale translation check passed: ${LOCALES.length} locale(s), ` +
    `${Object.keys(counted).length} key(s) each, no English left where a ` +
    "translation is owed."
);
