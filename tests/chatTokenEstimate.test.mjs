import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_ESTIMATOR_VERSION,
  estimatePromptTokens,
  estimateRawTextTokens,
  getCalibration,
  toReservedInputTokens,
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

// --- calibration structure (G1) ----------------------------------------------

test("the active calibration reproduces the shipped constants exactly", () => {
  const active = getCalibration();
  assert.equal(active.version, ACTIVE_ESTIMATOR_VERSION);
  assert.equal(ACTIVE_ESTIMATOR_VERSION, "generic_multilingual_v1");
  assert.equal(active.cjkTokensPerCharacter, 1.5);
  assert.equal(active.nonCjkBytesPerToken, 4);
  // v1 must stay the identity on reservation, or introducing the structure
  // would itself have been a billing change.
  assert.equal(active.reservationSafetyMultiplier, 1);
  assert.equal(active.reservationFramingOverheadTokens, 0);
});

test("estimateTextTokens is the raw estimate under the active calibration", () => {
  for (const sample of [
    "",
    "안녕하세요",
    "a".repeat(400),
    `${"한".repeat(100)}${"a".repeat(400)}`,
    "漢あ字カナ",
  ]) {
    assert.equal(estimateTextTokens(sample), estimateRawTextTokens(sample));
  }
});

test("v1 reserves exactly what it estimates, plus real tool overhead", () => {
  const raw = estimateRawTextTokens("한".repeat(100));
  assert.equal(toReservedInputTokens(raw), raw);
  assert.equal(
    toReservedInputTokens(raw, {
      toolOverheadTokens: estimateToolInputTokenOverhead({ nativeSearchEnabled: true }),
    }),
    raw + WEB_SEARCH_INPUT_TOKEN_OVERHEAD + TOOL_DEFINITION_INPUT_TOKEN_OVERHEAD
  );
});

test("v2 is defined but not active, and reserves above its own raw estimate", () => {
  const korean = "한".repeat(100);
  const v1Raw = estimateRawTextTokens(korean, "generic_multilingual_v1");
  const v2Raw = estimateRawTextTokens(korean, "generic_multilingual_v2");
  // 1.5 -> 0.8 per character is the measured correction, so v2 predicts far
  // fewer tokens for the same Korean text.
  assert.equal(v1Raw, 150);
  assert.equal(v2Raw, 80);
  assert.ok(v2Raw < v1Raw);

  // The safety margin lives only on the reservation, never on the raw value
  // ESTIMATE-01/02 grade.
  assert.equal(toReservedInputTokens(v2Raw, { version: "generic_multilingual_v2" }), 96);
  assert.notEqual(ACTIVE_ESTIMATOR_VERSION, "generic_multilingual_v2");
});

test("an unknown calibration version fails loudly rather than defaulting", () => {
  assert.throws(() => getCalibration("does-not-exist"), /Unknown estimator calibration/);
});
