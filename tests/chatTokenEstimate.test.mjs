import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_ESTIMATOR_VERSION,
  CJK_CHARACTER_PATTERN,
  estimatePromptTokens,
  estimateRawTextTokens,
  estimateTokenBreakdown,
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

// --- segment-scoped calibration (G1) -----------------------------------------

test("the active calibration reproduces the shipped constants exactly", () => {
  const active = getCalibration();
  assert.equal(active.version, ACTIVE_ESTIMATOR_VERSION);
  assert.equal(ACTIVE_ESTIMATOR_VERSION, "generic_multilingual_v1");
  assert.equal(active.hangulTokensPerCharacter, 1.5);
  assert.equal(active.hanKanaTokensPerCharacter, 1.5);
  assert.equal(active.nonCjkBytesPerToken, 4);
  // v1 must stay the identity on reservation, or introducing the structure
  // would itself have been a billing change.
  assert.deepEqual(active.reservationMultiplierBySegment, {
    hangul: 1,
    hanKana: 1,
    nonCjk: 1,
  });
  assert.equal(active.reservationMultiplierSource, "identity");
  assert.equal(active.reservationFramingOverheadTokens, 0);
});

test("estimateTextTokens is the raw estimate under the active calibration", () => {
  for (const sample of ["", "안녕하세요", "a".repeat(400), "漢あ字カナ"]) {
    assert.equal(estimateTextTokens(sample), estimateRawTextTokens(sample));
  }
});

test("the segment split sums to the same total the old single term produced", () => {
  const mixed = `${"한".repeat(100)}${"漢".repeat(50)}${"a".repeat(400)}`;
  const breakdown = estimateTokenBreakdown(mixed);
  assert.equal(breakdown.hangulCharacters, 100);
  assert.equal(breakdown.hanKanaCharacters, 50);
  // 150 CJK characters at 3 bytes each are removed from the byte term.
  assert.equal(breakdown.nonCjkBytes, 400);
  assert.equal(breakdown.tokensBySegment.hangul, 150);
  assert.equal(breakdown.tokensBySegment.hanKana, 75);
  assert.equal(breakdown.tokensBySegment.nonCjk, 100);
  assert.equal(breakdown.rawTotal, 325);
  assert.equal(estimateTextTokens(mixed), 325);
});

// The whole point of segment scoping: a Hangul recalibration must not move a
// request that contains no Hangul.
test("hangul_segment_v2 leaves non-Hangul text byte-for-byte identical to v1", () => {
  for (const sample of [
    "a".repeat(400),
    "what's the weather in Seoul today?",
    '{"a":1,"b":[2,3],"c":"d"}',
    "漢".repeat(100),
    "あいうえお".repeat(20),
    "カタカナ".repeat(25),
  ]) {
    assert.equal(
      estimateRawTextTokens(sample, "hangul_segment_v2"),
      estimateRawTextTokens(sample, "generic_multilingual_v1"),
      `changed for: ${sample.slice(0, 24)}`
    );
  }
});

test("hangul_segment_v2 changes only the Hangul term of mixed text", () => {
  const mixed = `${"한".repeat(100)}${"漢".repeat(50)}${"a".repeat(400)}`;
  const v1 = estimateTokenBreakdown(mixed, "generic_multilingual_v1");
  const v2 = estimateTokenBreakdown(mixed, "hangul_segment_v2");
  assert.equal(v2.tokensBySegment.hangul, 80);
  assert.equal(v1.tokensBySegment.hangul, 150);
  assert.equal(v2.tokensBySegment.hanKana, v1.tokensBySegment.hanKana);
  assert.equal(v2.tokensBySegment.nonCjk, v1.tokensBySegment.nonCjk);
});

test("v1 reserves exactly what it estimates, plus real tool overhead", () => {
  const breakdown = estimateTokenBreakdown("한".repeat(100));
  assert.equal(toReservedInputTokens(breakdown), breakdown.rawTotal);
  assert.equal(
    toReservedInputTokens(breakdown, {
      toolOverheadTokens: estimateToolInputTokenOverhead({ nativeSearchEnabled: true }),
    }),
    breakdown.rawTotal + WEB_SEARCH_INPUT_TOKEN_OVERHEAD + TOOL_DEFINITION_INPUT_TOKEN_OVERHEAD
  );
});

test("v2's provisional margin widens only the Hangul segment", () => {
  const mixed = `${"한".repeat(100)}${"a".repeat(400)}`;
  const v2 = estimateTokenBreakdown(mixed, "hangul_segment_v2");
  // 80 Hangul tokens * 1.20 = 96, plus the untouched 100 non-CJK tokens.
  assert.equal(toReservedInputTokens(v2), 196);
  const calibration = getCalibration("hangul_segment_v2");
  assert.equal(calibration.reservationMultiplierSource, "provisional_floor");
  assert.notEqual(ACTIVE_ESTIMATOR_VERSION, "hangul_segment_v2");
});

test("an unknown calibration version fails loudly rather than defaulting", () => {
  assert.throws(() => getCalibration("does-not-exist"), /Unknown estimator calibration/);
});

// Pins a defect rather than a design: the CJK class ends at U+8C48-U+FAFF,
// not the U+F900-U+FAFF compatibility block it reads as, because the literal
// in the source is U+8C48 -- a unified ideograph that renders identically to
// U+F900. Han/Kana is therefore derived as "CJK minus Hangul"; a separate
// Han/Kana class would also match Hangul and double-count every Korean
// character. Narrowing the range would move which characters are priced at the
// CJK rate, so it is a billing decision, not a cleanup. This test fails if
// someone makes it silently.
test("the CJK class still covers U+8C48-U+FAFF, and Hangul is counted once", () => {
  // A fresh non-global copy: .test() on a /g/ regex advances lastIndex, so
  // reusing the exported one here would make the second assertion stateful.
  const cjk = new RegExp(CJK_CHARACTER_PATTERN.source, "u");
  assert.ok(cjk.test(String.fromCodePoint(0xe000)), "PUA is inside the class");
  assert.ok(cjk.test("안"), "Hangul is inside the class");

  const breakdown = estimateTokenBreakdown("안".repeat(1_000));
  assert.equal(breakdown.hangulCharacters, 1_000);
  assert.equal(breakdown.hanKanaCharacters, 0, "Hangul must not also count as Han/Kana");
  assert.equal(breakdown.rawTotal, 1_500);
});
