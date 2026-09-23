// The clause parser, on its own.
//
// Two rules depend on it and both were wrong before it existed: the memory
// rule read a whole sentence, so a denial in the first clause covered a claim
// in the second, and the minors rule used a fixed-length lookbehind, so a
// safety notice was refused for saying the thing it denies. The cases here are
// the sentences that decided its shape.
//
// Contract: docs/policy/marketing-automation.md §7.1.

import assert from "node:assert/strict";
import test from "node:test";

import { marketingClauseAsserts } from "../lib/marketingNegation.ts";

/** Whether the clause holding `needle` asserts it. */
const asserts = (text, needle) => {
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, `${needle} is not in ${text}`);
  return marketingClauseAsserts(text, at, needle);
};

test("a negation governs its own clause and no further", () => {
  const cases = [
    // The denial and the claim in one sentence: the second clause is asserted.
    ["We do not lose files: we clone your memories.", "clone", true],
    ["We do not lose files, we clone your memories.", "clone", true],
    ["We never drop a message; we clone your memories.", "clone", true],
    ["We do not lose files and we clone your memories.", "clone", true],
    ["We do not lose files — we clone your memories.", "clone", true],
    // The denial governing the thing it denies.
    ["Tomverse does not clone your memories.", "clone", false],
    ["Tomverse cannot clone your memories.", "clone", false],
  ];
  for (const [text, needle, expected] of cases) {
    assert.equal(asserts(text, needle), expected, text);
  }
});

test("a comma that continues a predicate is not a clause boundary", () => {
  // This sentence is on a public page today, and it is there precisely to
  // avoid making the claim. A parser that broke at every comma would report it
  // and force the disclaimer off the page.
  const text = "Tomverse is not affiliated with, or endorsed by, OpenAI.";
  assert.equal(asserts(text, "endorsed by"), false);

  // A proper noun after a comma is a continuation too, not a new subject.
  assert.equal(
    asserts("We are not affiliated with, or owned by, Anthropic.", "owned by"),
    false,
  );
});

test("a question asserts nothing", () => {
  assert.equal(asserts("Does Tomverse clone your memories?", "clone"), false);
});

test("Korean negates at the end of its clause, however long", () => {
  assert.equal(
    asserts("Tomverse는 청소년을 위한 제품이 아닙니다.", "위한"),
    false,
  );
  assert.equal(
    asserts("청소년을 위한 학습 도구입니다.", "위한"),
    true,
  );
});

test("the apostrophe-less contractions are negators too", () => {
  // The Guard checks a form with its interior separators removed, where
  // "isn't" reads as "isnt". A safety notice was refused in that form.
  assert.equal(asserts("Tomverse isnt for under 16s.", "under 16s"), false);
  assert.equal(asserts("Tomverse isn't for under 16s.", "under 16s"), false);
});
