import assert from "node:assert/strict";
import test from "node:test";

import { estimateTokenBreakdown } from "../lib/chatTokenEstimate.ts";
import {
  buildShadowEstimate,
  calibrationExclusionReason,
  createShadowAccumulator,
  isCalibrationEligible,
  measureNonCjkSymbolRatio,
  resolveContentCohort,
  resolveInputUsageSource,
} from "../lib/tokenEstimateShadow.ts";

const sample = (overrides = {}) => ({
  attemptId: "attempt-1",
  modelId: "gpt-5-6-luna",
  providerId: "openai",
  controlEstimatorVersion: "generic_multilingual_v1",
  controlRawEstimatedInputTokens: 150,
  candidateEstimatorVersion: "hangul_segment_v2",
  candidateRawEstimatedInputTokens: 80,
  reservedInputTokens: 150,
  tokenizerFamily: "generic_multilingual",
  contentCohort: "hangul_dominant",
  hangulCharacters: 100,
  hanKanaCharacters: 0,
  nonCjkBytes: 0,
  nonCjkSymbolRatio: 0,
  providerReportedInputTokens: 78,
  inputUsageSource: "provider_reported",
  outcome: "completed",
  isPartial: false,
  isCancelled: false,
  isFallbackAttempt: false,
  ...overrides,
});

// --- input provenance --------------------------------------------------------

// The trap this whole field exists for: chatSecurity decides usageSource from
// whether the provider reported *output* tokens, while the input figure
// independently falls back to the reservation. A turn that reports output but
// not input would otherwise be calibrated as if the estimate were the truth.
test("input provenance is decided by input tokens alone", () => {
  assert.equal(
    resolveInputUsageSource({ providerReportedInputTokens: 421, providerReturnedUsage: true }),
    "provider_reported"
  );
  assert.equal(
    resolveInputUsageSource({ providerReportedInputTokens: null, providerReturnedUsage: true }),
    "fallback_estimator",
    "usage arrived but carried no input count"
  );
  assert.equal(
    resolveInputUsageSource({ providerReportedInputTokens: null, providerReturnedUsage: false }),
    "missing"
  );
  assert.equal(
    resolveInputUsageSource({ providerReportedInputTokens: 0, providerReturnedUsage: true }),
    "fallback_estimator",
    "zero is not a reported count"
  );
});

// --- calibration eligibility -------------------------------------------------

test("a provider-reported, completed turn is eligible", () => {
  assert.equal(calibrationExclusionReason(sample()), null);
  assert.equal(isCalibrationEligible(sample()), true);
});

test("every exclusion names its own reason", () => {
  const cases = [
    [{ inputUsageSource: "fallback_estimator" }, "input_usage_not_provider_reported"],
    [{ inputUsageSource: "missing" }, "input_usage_not_provider_reported"],
    [{ outcome: "failed" }, "outcome_not_completed"],
    [{ outcome: "cancelled" }, "outcome_not_completed"],
    [{ isPartial: true }, "partial_response"],
    [{ isCancelled: true }, "cancelled_request"],
    [{ providerReportedInputTokens: 0 }, "non_positive_provider_input"],
    [{ providerReportedInputTokens: null }, "non_positive_provider_input"],
  ];
  for (const [overrides, expected] of cases) {
    const subject = sample(overrides);
    assert.equal(
      calibrationExclusionReason(subject),
      expected,
      `expected ${expected} for ${JSON.stringify(overrides)}`
    );
    assert.equal(isCalibrationEligible(subject), false);
  }
});

// A fallback attempt is a real, provider-answered turn on a different model, so
// it stays eligible -- but it is flagged, so the harness can treat it as its own
// sample rather than mixing it with the primary attempt.
test("a fallback attempt is still eligible, and stays labelled", () => {
  const subject = sample({ isFallbackAttempt: true });
  assert.equal(isCalibrationEligible(subject), true);
  assert.equal(subject.isFallbackAttempt, true);
});

// --- cohort classification ---------------------------------------------------

test("cohorts are derived from counts, without the text", () => {
  const cohortOf = (text) =>
    resolveContentCohort(estimateTokenBreakdown(text), {
      nonCjkSymbolRatio: measureNonCjkSymbolRatio(text),
    });
  assert.equal(cohortOf("한국어로만 작성된 문장입니다"), "hangul_dominant");
  assert.equal(cohortOf("これは日本語だけの文章です"), "han_kana_dominant");
  assert.equal(cohortOf("中文句子只有中文内容在这里"), "han_kana_dominant");
  assert.equal(
    cohortOf(
      "When choosing a model, what matters most is the shape of the question and how much context it carries."
    ),
    "latin_prose"
  );
  assert.equal(cohortOf(""), "latin_prose", "an empty request must classify, not throw");
});

// The case the aggregate would hide: Korean prose wrapped around a large code
// block is neither Hangul-dominant nor pure Latin, and it is exactly where a
// Hangul-only recalibration needs watching.
test("Korean around a code block is its own cohort, not hangul_dominant", () => {
  const mixed = `이 함수를 고쳐주세요.\n${'const x = {"a":1,"b":[2,3]};\n'.repeat(12)}`;
  assert.equal(
    resolveContentCohort(estimateTokenBreakdown(mixed), {
      nonCjkSymbolRatio: measureNonCjkSymbolRatio(mixed),
    }),
    "mixed_cjk_latin"
  );
});

test("dense punctuation is classified as code_json rather than prose", () => {
  const payload = '{"a":1,"b":[2,3],"c":{"d":"e"},"f":[4,5,6],"g":null,"h":true}';
  assert.equal(
    resolveContentCohort(estimateTokenBreakdown(payload), {
      nonCjkSymbolRatio: measureNonCjkSymbolRatio(payload),
    }),
    "code_json"
  );

  // Bytes-per-token would classify all three of these identically, because the
  // control estimate is bytes divided by a constant. The symbol ratio is what
  // actually separates them.
  assert.ok(measureNonCjkSymbolRatio(payload) > 0.5, "JSON is symbol-dense");
  assert.ok(
    measureNonCjkSymbolRatio("const rows = await prisma.routingRun.findMany({ take: 20 });") > 0.1,
    "code is symbol-dense"
  );
  assert.ok(
    measureNonCjkSymbolRatio("When choosing a model, what matters most is the question.") < 0.1,
    "prose is not"
  );
});

// --- shadow estimate construction --------------------------------------------

test("buildShadowEstimate records both estimates and no text", () => {
  const built = buildShadowEstimate("한국어 질문입니다", {
    controlVersion: "generic_multilingual_v1",
    candidateVersion: "hangul_segment_v2",
  });
  assert.equal(built.controlEstimatorVersion, "generic_multilingual_v1");
  assert.equal(built.candidateEstimatorVersion, "hangul_segment_v2");
  assert.ok(built.candidateRawEstimatedInputTokens < built.controlRawEstimatedInputTokens);
  assert.equal(built.contentCohort, "hangul_dominant");
  assert.ok(built.hangulCharacters > 0);

  // Nothing in the built record may carry the request itself.
  const serialised = JSON.stringify(built);
  assert.ok(!serialised.includes("한국어"), "prompt text must not survive into a sample");
  assert.deepEqual(
    Object.keys(built).filter((key) => typeof built[key] === "string" && key.endsWith("Text")),
    []
  );
});

test("the control estimate is the one that reflects shipped behaviour", () => {
  const text = "한".repeat(100);
  const built = buildShadowEstimate(text, {
    controlVersion: "generic_multilingual_v1",
    candidateVersion: "hangul_segment_v2",
  });
  assert.equal(built.controlRawEstimatedInputTokens, 150);
  assert.equal(built.candidateRawEstimatedInputTokens, 80);
});

// --- accumulator (the wiring the chat route uses) -----------------------------

test("the accumulator sums text-derived tokens across a whole turn", () => {
  const accumulator = createShadowAccumulator({
    controlVersion: "generic_multilingual_v1",
    candidateVersion: "hangul_segment_v2",
  });
  assert.equal(accumulator.hasText, false, "an empty turn is not worth recording");

  accumulator.add("한".repeat(100));
  accumulator.add("a".repeat(400));
  assert.equal(accumulator.hasText, true);

  const snapshot = accumulator.snapshot();
  assert.equal(snapshot.hangulCharacters, 100);
  assert.equal(snapshot.nonCjkBytes, 400);
  // Control text total is 150 + 100; the candidate replaces only the Hangul
  // term, giving 80 + 100.
  assert.equal(accumulator.candidateTotalFrom(250), 180);
});

// Memory tokens arrive as an already-reserved figure and native attachments are
// priced by count, so neither passes through the text path. No calibration of
// character segments can move them, and they must survive into both arms
// unchanged rather than being dropped from the candidate.
test("non-text tokens carry across to the candidate unchanged", () => {
  const accumulator = createShadowAccumulator({
    controlVersion: "generic_multilingual_v1",
    candidateVersion: "hangul_segment_v2",
  });
  accumulator.add("한".repeat(100));

  // 150 text tokens plus 500 that never came from text.
  assert.equal(accumulator.candidateTotalFrom(650), 580);
  assert.equal(
    accumulator.candidateTotalFrom(650) - 500,
    80,
    "only the text-derived part changes"
  );
});

test("the accumulator never returns a negative candidate total", () => {
  const accumulator = createShadowAccumulator({
    controlVersion: "generic_multilingual_v1",
    candidateVersion: "hangul_segment_v2",
  });
  accumulator.add("한".repeat(100));
  assert.equal(accumulator.candidateTotalFrom(0), 0);
});

test("a turn of pure Latin produces an identical candidate total", () => {
  const accumulator = createShadowAccumulator({
    controlVersion: "generic_multilingual_v1",
    candidateVersion: "hangul_segment_v2",
  });
  accumulator.add("what's the weather in Seoul today?");
  accumulator.add('{"a":1,"b":[2,3]}');
  const control = 40;
  assert.equal(
    accumulator.candidateTotalFrom(control),
    control,
    "a Hangul-only calibration must not move a request with no Hangul"
  );
});
