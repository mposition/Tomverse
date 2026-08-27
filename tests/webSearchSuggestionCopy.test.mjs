import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";
import { zh } from "../locales/zh.ts";
import { fr } from "../locales/fr.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { pt } from "../locales/pt.ts";
import { resolveWebSearchSuggestionCopy } from "../components/chat/webSearchSuggestionCopy.ts";

/**
 * The web-search offer's words.
 *
 * Four things are held here that a screenshot review would not catch
 * reliably: that every shipped locale has the strings at all, that the two
 * states with nothing to press really offer nothing, that the card never
 * carries the user's own text, and that no locale sends the user somewhere
 * else to do the search themselves.
 */

const locales = { en, ko, zh, fr, de, es, pt };

const requiredKeys = [
  "webSearchSuggestionTitle",
  "webSearchSuggestionDescription",
  "webSearchSuggestionEstimate",
  "webSearchSuggestionConfirm",
  "webSearchSuggestionDismiss",
  "webSearchSuggestionStarting",
  "webSearchSuggestionUnsupportedTitle",
  "webSearchSuggestionUnsupportedDescription",
  "webSearchSuggestionBlockedTitle",
  "webSearchSuggestionBlockedDescription",
  "webSearchSuggestionErrorTitle",
  "webSearchSuggestionErrorDescription",
  "webSearchSuggestionRetry",
];

const translate = (dictionary) => (key) =>
  key
    .split(".")
    .reduce((node, part) => (node ?? {})[part], dictionary) ?? key;

test("every shipped locale carries the whole card", () => {
  for (const [name, dictionary] of Object.entries(locales)) {
    for (const key of requiredKeys) {
      const value = dictionary.chat?.[key];
      assert.equal(typeof value, "string", `${name}.chat.${key}`);
      assert.ok(value.trim().length > 0, `${name}.chat.${key} is empty`);
    }
  }
});

test("the actionable state has a primary action and an estimate", () => {
  const copy = resolveWebSearchSuggestionCopy({
    t: translate(ko),
    state: "enable",
    surchargeCredits: 8,
  });
  assert.equal(copy.primary, ko.chat.webSearchSuggestionConfirm);
  assert.equal(copy.dismiss, ko.chat.webSearchSuggestionDismiss);
  assert.ok(copy.estimate?.includes("8"));
});

test("no credit figure means no estimate line, never a zero", () => {
  for (const surchargeCredits of [null, 0]) {
    const copy = resolveWebSearchSuggestionCopy({
      t: translate(ko),
      state: "enable",
      surchargeCredits,
    });
    assert.equal(copy.estimate, null);
  }
});

test("the two states with nothing to press offer no primary action", () => {
  for (const state of ["unsupported", "blocked"]) {
    const copy = resolveWebSearchSuggestionCopy({
      t: translate(ko),
      state,
      surchargeCredits: 8,
    });
    assert.equal(copy.primary, null, state);
    // Still dismissible: a card that cannot be put away is worse than no card.
    assert.ok(copy.dismiss.trim().length > 0, state);
    assert.equal(copy.estimate, null, state);
  }
});

test("a failed run offers a retry, not a fresh search", () => {
  const copy = resolveWebSearchSuggestionCopy({
    t: translate(ko),
    state: "error",
    surchargeCredits: 8,
  });
  assert.equal(copy.primary, ko.chat.webSearchSuggestionRetry);
});

test("every state resolves to real strings in every locale", () => {
  for (const [name, dictionary] of Object.entries(locales)) {
    for (const state of ["enable", "unsupported", "blocked", "error"]) {
      const copy = resolveWebSearchSuggestionCopy({
        t: translate(dictionary),
        state,
        surchargeCredits: 8,
      });
      for (const [field, value] of Object.entries(copy)) {
        if (value === null) continue;
        assert.equal(typeof value, "string", `${name}/${state}/${field}`);
        // An unresolved key falls through as the key itself.
        assert.ok(
          !value.startsWith("chat."),
          `${name}/${state}/${field} did not resolve`
        );
      }
    }
  }
});

test("no placeholder survives into a rendered string", () => {
  // A leftover `{credits}` is a template the user reads. The estimate is the
  // only interpolated line, so the whole card is checked rather than it alone.
  for (const [name, dictionary] of Object.entries(locales)) {
    for (const state of ["enable", "unsupported", "blocked", "error"]) {
      const copy = resolveWebSearchSuggestionCopy({
        t: translate(dictionary),
        state,
        surchargeCredits: 8,
      });
      for (const [field, value] of Object.entries(copy)) {
        if (typeof value !== "string") continue;
        assert.ok(
          !/\{[a-zA-Z]+\}/.test(value),
          `${name}/${state}/${field}: unfilled placeholder in "${value}"`
        );
      }
    }
  }
});

test("the card has no slot for the user's own question", () => {
  /*
    The copy is deliberately generic. Interpolating the subject or the place
    out of the question would need an extraction this module has no way to do
    reliably -- and the raw text carries the user's own markdown, so a
    `**서울** 날씨` would surface its asterisks in a plain-text card. So no
    template here takes anything but a number.
  */
  for (const [name, dictionary] of Object.entries(locales)) {
    for (const key of requiredKeys) {
      const value = dictionary.chat[key];
      for (const placeholder of value.match(/\{[a-zA-Z]+\}/g) ?? []) {
        assert.equal(
          placeholder,
          "{credits}",
          `${name}.chat.${key} interpolates ${placeholder}`
        );
      }
    }
  }
});

test("no locale hands the user off to another app to search for themselves", () => {
  /*
    The dead end this feature replaces was a sentence naming a weather service
    and a phone app. The product can run this search; telling somebody to go
    and do it elsewhere is the failure, not the fallback.
  */
  const handoff =
    /기상청|날씨누리|날씨\s*앱|google\.com|naver\.com|검색해\s*(보세요|확인)|search engine|check (a|another) (app|site|website)|look it up (yourself|elsewhere)/i;
  for (const [name, dictionary] of Object.entries(locales)) {
    for (const key of requiredKeys) {
      assert.ok(
        !handoff.test(dictionary.chat[key]),
        `${name}.chat.${key} sends the user elsewhere`
      );
    }
  }
});

test("the unsupported and blocked states say different things", () => {
  /*
    "The models here cannot search" and "the service will not run the search"
    are different facts with different remedies -- one is a model choice the
    user can change, the other is not. Copy that collapsed them would leave the
    user changing models against a block that follows them.
  */
  for (const [name, dictionary] of Object.entries(locales)) {
    assert.notEqual(
      dictionary.chat.webSearchSuggestionUnsupportedDescription,
      dictionary.chat.webSearchSuggestionBlockedDescription,
      name
    );
  }
});
