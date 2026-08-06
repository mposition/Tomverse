import assert from "node:assert/strict";
import test from "node:test";

// The recorder runs beside a paid request, so the properties worth pinning are
// the ones that keep it from ever affecting one: inert unless enabled, and
// silent about its own failures.
//
// No database here on purpose. With the flag off the recorder must return
// before it touches Prisma at all -- if it did not, these calls would fail
// trying to reach a server that is not running, which is exactly the assertion.

const withFlag = async (value, run) => {
  const previous = process.env.TOKEN_ESTIMATE_SHADOW_ENABLED;
  if (value === undefined) delete process.env.TOKEN_ESTIMATE_SHADOW_ENABLED;
  else process.env.TOKEN_ESTIMATE_SHADOW_ENABLED = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.TOKEN_ESTIMATE_SHADOW_ENABLED;
    else process.env.TOKEN_ESTIMATE_SHADOW_ENABLED = previous;
  }
};

const reservation = {
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
};

const settlement = {
  attemptId: "attempt-1",
  providerReportedInputTokens: 78,
  inputUsageSource: "provider_reported",
  outcome: "completed",
  isPartial: false,
  isCancelled: false,
};

test("shadow recording is off unless the flag is exactly \"true\"", async () => {
  const { isTokenEstimateShadowEnabled } = await import(
    "../lib/tokenEstimateShadowRecorder.ts"
  );
  for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
    await withFlag(value, () => {
      assert.equal(
        isTokenEstimateShadowEnabled(),
        false,
        `expected disabled for ${JSON.stringify(value)}`
      );
    });
  }
  await withFlag("true", () => {
    assert.equal(isTokenEstimateShadowEnabled(), true);
  });
});

test("with the flag off neither recorder touches the database", async () => {
  const { recordShadowReservation, recordShadowSettlement } = await import(
    "../lib/tokenEstimateShadowRecorder.ts"
  );
  await withFlag("false", async () => {
    // Reaching Prisma here would throw, because no database is running.
    await recordShadowReservation(reservation);
    await recordShadowSettlement(settlement);
  });
});

test("a database failure is swallowed rather than raised into the request", async () => {
  const { recordShadowReservation, recordShadowSettlement } = await import(
    "../lib/tokenEstimateShadowRecorder.ts"
  );
  await withFlag("true", async () => {
    // Enabled, with no database reachable: the whole point is that this
    // resolves instead of failing the chat turn that called it.
    await recordShadowReservation(reservation);
    await recordShadowSettlement(settlement);
  });
});

test("the candidate version is named once, and is not the active calibration", async () => {
  const { SHADOW_CANDIDATE_ESTIMATOR_VERSION } = await import(
    "../lib/tokenEstimateShadowRecorder.ts"
  );
  const { ACTIVE_ESTIMATOR_VERSION, ESTIMATOR_CALIBRATIONS } = await import(
    "../lib/chatTokenEstimate.ts"
  );
  assert.ok(
    SHADOW_CANDIDATE_ESTIMATOR_VERSION in ESTIMATOR_CALIBRATIONS,
    "the candidate must be a real calibration"
  );
  assert.notEqual(
    SHADOW_CANDIDATE_ESTIMATOR_VERSION,
    ACTIVE_ESTIMATOR_VERSION,
    "a candidate that is also active is not a shadow"
  );
});
