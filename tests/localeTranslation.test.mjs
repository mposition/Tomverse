import assert from "node:assert/strict";
import test from "node:test";

import {
  findStaleAllowlistEntries,
  findUntranslatedStrings,
  flattenLocale,
  MIN_TRANSLATABLE_LENGTH,
  SHARED_STRING_ALLOWLIST,
} from "../scripts/check-locale-translation-core.mjs";

// The locales are complete by key and always have been -- a missing key fails
// at build time. What never failed is a key whose *value* is still the English
// sentence, which is how the account-data-export UI shipped in English to five
// locales while Korean was translated.
//
// These tests are about where the line sits: strict enough to have caught that,
// loose enough not to report every "OK" and "{count}" in the bundle.

const flat = (object) => Object.fromEntries(flattenLocale(object));

const english = flat({
  page: {
    title: "Download your account data",
    short: "Download",
    counter: "{count} / {max}",
    brand: "Tomverse Review",
  },
});

const allowlist = [
  { key: "page.brand", locales: "all", reason: "The product name." },
  // A bare counter is long enough and has whitespace, so the rule does see it.
  // It takes an allowlist entry rather than a silent exemption on purpose:
  // Korean *does* translate this one, appending its own unit, so "there is
  // nothing here to translate" is a per-locale judgement, not a property of the
  // string.
  {
    key: "page.counter",
    locales: ["de"],
    reason: "Numbers only; German renders them as English does.",
  },
];

test("an English sentence repeated in another locale is reported", () => {
  const problems = findUntranslatedStrings({
    english,
    locales: {
      de: flat({
        page: {
          title: "Download your account data",
          short: "Download",
          counter: "{count} / {max}",
          brand: "Tomverse Review",
        },
      }),
    },
    allowlist,
  });

  assert.deepEqual(
    problems.map((problem) => problem.key),
    ["page.title"]
  );
  assert.equal(problems[0].locale, "de");
});

test("a translated locale reports nothing", () => {
  assert.deepEqual(
    findUntranslatedStrings({
      english,
      locales: {
        de: flat({
          page: {
            title: "Kontodaten herunterladen",
            short: "Download",
            counter: "{count} / {max}",
            brand: "Tomverse Review",
          },
        }),
      },
      allowlist,
    }),
    []
  );
});

// The narrowing rules, stated separately because each is a decision about
// noise rather than a detail of the implementation.
test("short strings and single words are not translations anybody owes", () => {
  const problems = findUntranslatedStrings({
    english: flat({
      a: { short: "Download", oneWord: "Configuration blahblahblah" },
    }),
    locales: { de: flat({ a: { short: "Download", oneWord: "Configuration blahblahblah" } }) },
    allowlist: [],
  });
  // "Download" is under the length floor; the long single word has no
  // whitespace, so neither is reported.
  assert.deepEqual(problems.map((problem) => problem.key), ["a.oneWord"]);
  assert.ok(MIN_TRANSLATABLE_LENGTH > "Download".length);
});

test("an allowlisted key is silent only in the locales it names", () => {
  const source = flat({ a: { line: "Docs, Sheets, Slides" } });
  const shared = { a: { line: "Docs, Sheets, Slides" } };
  const problems = findUntranslatedStrings({
    english: source,
    locales: { fr: flat(shared), de: flat(shared) },
    allowlist: [{ key: "a.line", locales: ["fr"], reason: "Google product names." }],
  });
  assert.deepEqual(
    problems.map((problem) => problem.locale),
    ["de"]
  );
});

// A stale entry is how the rule quietly stops covering a key: the string is
// translated, the entry stays, and the next English regression is permitted.
test("an allowlist entry whose locales all differ is reported as stale", () => {
  const stale = findStaleAllowlistEntries({
    english: flat({ a: { line: "A sentence worth translating" } }),
    locales: { de: flat({ a: { line: "Ein übersetzter Satz" } }) },
    allowlist: [{ key: "a.line", locales: ["de"], reason: "was deliberate once" }],
  });
  assert.equal(stale.length, 1);
  assert.match(stale[0].problem, /now differs/);
});

test("an allowlist entry without a reason is stale by definition", () => {
  const shared = flat({ a: { line: "A sentence worth translating" } });
  const stale = findStaleAllowlistEntries({
    english: shared,
    locales: { de: shared },
    allowlist: [{ key: "a.line", locales: ["de"], reason: "  " }],
  });
  assert.equal(stale.length, 1);
  assert.match(stale[0].problem, /no reason/);
});

test("an allowlist entry naming a key that no longer exists is stale", () => {
  const stale = findStaleAllowlistEntries({
    english: flat({ a: { line: "A sentence worth translating" } }),
    locales: { de: flat({ a: { line: "Ein übersetzter Satz" } }) },
    allowlist: [{ key: "a.removed", locales: "all", reason: "gone" }],
  });
  assert.equal(stale.length, 1);
  assert.match(stale[0].problem, /no such English string/);
});

// The shipped allowlist, not a fixture: every entry has to say why, so an
// untranslated string cannot be silenced by adding a bare key.
test("every shipped allowlist entry states a reason", () => {
  for (const entry of SHARED_STRING_ALLOWLIST) {
    assert.ok(
      typeof entry.reason === "string" && entry.reason.trim().length > 10,
      `${entry.key} has no usable reason`
    );
    assert.ok(
      entry.locales === "all" || Array.isArray(entry.locales),
      `${entry.key} has no locale scope`
    );
  }
});

test("flattenLocale keys by dotted path and keeps arrays whole", () => {
  assert.deepEqual(flat({ a: { b: "x", c: ["y", "z"] } }), {
    "a.b": "x",
    "a.c": ["y", "z"],
  });
});
