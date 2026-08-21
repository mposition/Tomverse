import assert from "node:assert/strict";
import test from "node:test";
import {
  draftSuggestionKey,
  hasExplicitSourceOrSearchIntent,
  suggestsRecentInformationNeeded,
  suggestsWebSearchInComposer,
} from "../lib/webSearchSuggestion.ts";

// The composer's nudge. Every case below behaved this way before the split and
// must keep behaving this way: the four-character floor is a typing-time rule
// and nothing about the UI changed.

test("the composer nudge flags Korean recency keywords", () => {
  assert.equal(suggestsWebSearchInComposer("오늘 환율이 어떻게 돼?"), true);
  assert.equal(suggestsWebSearchInComposer("최신 뉴스 알려줘"), true);
});

test("the composer nudge flags English recency keywords", () => {
  assert.equal(suggestsWebSearchInComposer("What's the latest news on this?"), true);
  assert.equal(suggestsWebSearchInComposer("What is today's weather forecast?"), true);
});

test("the composer nudge flags research/citation intent (shared with modelFinder)", () => {
  assert.equal(
    suggestsWebSearchInComposer("Can you give me sources for this claim?"),
    true
  );
});

test("the composer nudge does not flag ordinary questions", () => {
  assert.equal(suggestsWebSearchInComposer("Explain how photosynthesis works."), false);
  assert.equal(suggestsWebSearchInComposer("파이썬 리스트 정렬하는 법 알려줘"), false);
});

test("the composer nudge ignores very short or empty drafts", () => {
  // Unchanged, and deliberately so: a suggestion that appears after two
  // keystrokes flickers under the cursor. This floor is about typing.
  assert.equal(suggestsWebSearchInComposer(""), false);
  assert.equal(suggestsWebSearchInComposer("hi"), false);
  assert.equal(suggestsWebSearchInComposer("출처"), false);
});

test("the composer nudge requires a bare recent year alongside other context, not a random old year", () => {
  assert.equal(suggestsWebSearchInComposer("Tell me about the iPhone 15"), false);
  assert.equal(suggestsWebSearchInComposer("What happened in 2026 so far"), true);
});

// Stated intent, for routing and capability. This is the half that must not
// carry the composer's floor: `needsCurrentInformation` drives the Router's
// web-search hard filter, so a two-character request for sources reading as
// "no request" left a model with no search path eligible for a turn that had
// asked for sources.

test("explicit source intent is recognised at any length", () => {
  assert.equal(hasExplicitSourceOrSearchIntent("출처"), true);
  assert.equal(hasExplicitSourceOrSearchIntent("근거"), true);
  assert.equal(hasExplicitSourceOrSearchIntent("웹검색"), true);
  assert.equal(hasExplicitSourceOrSearchIntent("  출처  "), true);
  assert.equal(
    hasExplicitSourceOrSearchIntent("Can you give me sources for this claim?"),
    true
  );
});

test("explicit source intent is intent, not a guess from wording", () => {
  // Recency wording is not a request for sources. It is the other signal, and
  // conflating them is what produced one function doing two jobs.
  assert.equal(hasExplicitSourceOrSearchIntent("오늘 환율이 어떻게 돼?"), false);
  assert.equal(hasExplicitSourceOrSearchIntent("Explain how photosynthesis works."), false);
  assert.equal(hasExplicitSourceOrSearchIntent(""), false);
});

test("the recency reading keeps its floor wherever it is used", () => {
  // A bare "오늘" is ambiguous in a way "출처" is not: it is a guess about what
  // the turn needs rather than something the person asked for. Widening it is
  // a separate decision, with its own evidence.
  assert.equal(suggestsRecentInformationNeeded("오늘 서울 날씨"), true);
  assert.equal(suggestsRecentInformationNeeded("오늘"), false);
  assert.equal(suggestsRecentInformationNeeded("출처"), false);
});

test("draftSuggestionKey normalizes for dedupe (trim + case)", () => {
  assert.equal(draftSuggestionKey("  Today's News  "), "today's news");
  assert.equal(
    draftSuggestionKey("Today's News"),
    draftSuggestionKey("  today's news ")
  );
});
