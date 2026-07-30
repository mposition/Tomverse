import assert from "node:assert/strict";
import test from "node:test";
import {
  draftSuggestionKey,
  suggestsCurrentInformationNeeded,
} from "../lib/webSearchSuggestion.ts";

test("suggestsCurrentInformationNeeded flags Korean recency keywords", () => {
  assert.equal(suggestsCurrentInformationNeeded("오늘 환율이 어떻게 돼?"), true);
  assert.equal(suggestsCurrentInformationNeeded("최신 뉴스 알려줘"), true);
});

test("suggestsCurrentInformationNeeded flags English recency keywords", () => {
  assert.equal(
    suggestsCurrentInformationNeeded("What's the latest news on this?"),
    true
  );
  assert.equal(
    suggestsCurrentInformationNeeded("What is today's weather forecast?"),
    true
  );
});

test("suggestsCurrentInformationNeeded flags research/citation intent (shared with modelFinder)", () => {
  assert.equal(
    suggestsCurrentInformationNeeded("Can you give me sources for this claim?"),
    true
  );
});

test("suggestsCurrentInformationNeeded does not flag ordinary questions", () => {
  assert.equal(suggestsCurrentInformationNeeded("Explain how photosynthesis works."), false);
  assert.equal(suggestsCurrentInformationNeeded("파이썬 리스트 정렬하는 법 알려줘"), false);
});

test("suggestsCurrentInformationNeeded ignores very short or empty drafts", () => {
  assert.equal(suggestsCurrentInformationNeeded(""), false);
  assert.equal(suggestsCurrentInformationNeeded("hi"), false);
});

test("suggestsCurrentInformationNeeded requires a bare recent year alongside other context, not a random old year", () => {
  assert.equal(suggestsCurrentInformationNeeded("Tell me about the iPhone 15"), false);
  assert.equal(suggestsCurrentInformationNeeded("What happened in 2026 so far"), true);
});

test("draftSuggestionKey normalizes for dedupe (trim + case)", () => {
  assert.equal(draftSuggestionKey("  Today's News  "), "today's news");
  assert.equal(
    draftSuggestionKey("Today's News"),
    draftSuggestionKey("  today's news ")
  );
});
