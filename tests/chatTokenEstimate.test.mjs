import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePromptTokens,
  estimateTextTokens,
  estimateToolInputTokenOverhead,
  TOOL_DEFINITION_INPUT_TOKEN_OVERHEAD,
  WEB_SEARCH_INPUT_TOKEN_OVERHEAD,
} from "../lib/chatTokenEstimate.ts";

test("Korean text is not underestimated by the byte heuristic", () => {
  const korean = "안".repeat(1_000);
  // A pure bytes/4 estimate gives 750 tokens for 1,000 Hangul characters,
  // which is the shape of underestimate that made reservations too small.
  assert.equal(Math.ceil(Buffer.byteLength(korean, "utf8") / 4), 750);
  assert.equal(estimateTextTokens(korean), 1_500);
});

test("Han and Kana are counted the same way as Hangul", () => {
  assert.equal(estimateTextTokens("漢".repeat(100)), 150);
  assert.equal(estimateTextTokens("あ".repeat(100)), 150);
});

test("Latin text keeps the byte heuristic", () => {
  const latin = "a".repeat(400);
  assert.equal(estimateTextTokens(latin), 100);
});

test("mixed text adds the two estimates rather than picking one", () => {
  const mixed = `${"한".repeat(100)}${"a".repeat(400)}`;
  assert.equal(estimateTextTokens(mixed), 150 + 100);
});

test("empty text costs nothing and non-empty text costs at least one token", () => {
  assert.equal(estimatePromptTokens(""), 0);
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimatePromptTokens("."), 1);
});

test("a native search turn reserves input headroom for the retrieved results", () => {
  assert.equal(
    estimateToolInputTokenOverhead({ nativeSearchEnabled: true }),
    WEB_SEARCH_INPUT_TOKEN_OVERHEAD + TOOL_DEFINITION_INPUT_TOKEN_OVERHEAD
  );
  assert.equal(
    estimateToolInputTokenOverhead({ nativeSearchEnabled: false }),
    0
  );
});
