import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOFIX_CASE_STATE,
  AUTOFIX_CLASSIFICATION,
  AUTOFIX_MAX_COLLECT_ATTEMPTS,
  autoFixCollectBackoffMs,
  canTransitionAutoFixCase,
  classifyAutoFixCase,
  isAutoFixFixingEnabled,
  isAutoFixShadowModeEnabled,
} from "../lib/feedbackAutoFixCore";

/**
 * Phase 2 shadow-case rules. Two contracts matter here:
 *   - the state graph forbids jumps to arbitrary terminal states, and
 *   - classification is deterministic: no LLM verdict, no confidence number,
 *     ever decides eligibility. `application_candidate` only ever means
 *     "worth a human's diagnostic attention".
 */

test("the happy path through the state graph is allowed", () => {
  const path = [
    AUTOFIX_CASE_STATE.received,
    AUTOFIX_CASE_STATE.collectingEvidence,
    AUTOFIX_CASE_STATE.evidenceReady,
    AUTOFIX_CASE_STATE.classifying,
    AUTOFIX_CASE_STATE.diagnosticReady,
    AUTOFIX_CASE_STATE.awaitingHumanReview,
    AUTOFIX_CASE_STATE.closed,
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.ok(
      canTransitionAutoFixCase(path[i], path[i + 1]),
      `${path[i]} -> ${path[i + 1]}`
    );
  }
});

test("evidence delay loops back to collection, and only there", () => {
  assert.ok(
    canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.collectingEvidence,
      AUTOFIX_CASE_STATE.evidenceDelayed
    )
  );
  assert.ok(
    canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.evidenceDelayed,
      AUTOFIX_CASE_STATE.collectingEvidence
    )
  );
  assert.ok(
    !canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.evidenceDelayed,
      AUTOFIX_CASE_STATE.diagnosticReady
    )
  );
});

test("no state may jump straight to closed except review and ineligible", () => {
  for (const from of [
    AUTOFIX_CASE_STATE.received,
    AUTOFIX_CASE_STATE.collectingEvidence,
    AUTOFIX_CASE_STATE.evidenceReady,
    AUTOFIX_CASE_STATE.evidenceDelayed,
    AUTOFIX_CASE_STATE.classifying,
    AUTOFIX_CASE_STATE.diagnosticReady,
  ]) {
    assert.ok(
      !canTransitionAutoFixCase(from, AUTOFIX_CASE_STATE.closed),
      `${from} must not close directly`
    );
  }
  assert.ok(
    canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.awaitingHumanReview,
      AUTOFIX_CASE_STATE.closed
    )
  );
  assert.ok(
    canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.ineligible,
      AUTOFIX_CASE_STATE.closed
    )
  );
  assert.ok(!canTransitionAutoFixCase(AUTOFIX_CASE_STATE.closed, AUTOFIX_CASE_STATE.received));
  assert.ok(!canTransitionAutoFixCase("nonsense", AUTOFIX_CASE_STATE.closed));
});

test("an unverified report classifies as untrusted_trace", () => {
  const outcome = classifyAutoFixCase({
    errorReportVerification: "missing_token",
    errorClassificationSource: "server",
    clientErrorCode: null,
    evidenceAvailability: "recorded",
    evidence: { errorCode: "AI_PROVIDER_ERROR", retryable: false, httpStatus: 500 },
  });
  assert.equal(outcome.classification, AUTOFIX_CLASSIFICATION.untrustedTrace);
  assert.equal(outcome.eligible, false);
});

test("a client-classified empty response without evidence stays observational", () => {
  const outcome = classifyAutoFixCase({
    errorReportVerification: "verified",
    errorClassificationSource: "client",
    clientErrorCode: "EMPTY_RESPONSE",
    evidenceAvailability: "intentionally_not_recorded",
    evidence: null,
  });
  assert.equal(outcome.classification, AUTOFIX_CLASSIFICATION.clientClassified);
  assert.equal(outcome.eligible, false);
});

test("limit refusals point at their existing records", () => {
  const outcome = classifyAutoFixCase({
    errorReportVerification: "verified",
    errorClassificationSource: "server",
    clientErrorCode: null,
    evidenceAvailability: "existing_limit_event",
    evidence: null,
  });
  assert.equal(outcome.classification, AUTOFIX_CLASSIFICATION.operationalLimit);
  assert.equal(outcome.eligible, false);
});

test("retryable and provider-side failures are provider_transient", () => {
  for (const evidence of [
    { errorCode: "AI_PROVIDER_ERROR", retryable: true, httpStatus: 500 },
    { errorCode: "AI_EMPTY_RESPONSE.STOP", retryable: null, httpStatus: 200 },
    { errorCode: "DEEP_RESEARCH_JOB_FAILED", retryable: null, httpStatus: 200 },
  ]) {
    const outcome = classifyAutoFixCase({
      errorReportVerification: "verified",
      errorClassificationSource: "server",
      clientErrorCode: null,
      evidenceAvailability: "recorded",
      evidence,
    });
    assert.equal(
      outcome.classification,
      AUTOFIX_CLASSIFICATION.providerTransient,
      evidence.errorCode
    );
    assert.equal(outcome.eligible, false);
  }
});

test("only a verified, recorded, non-transient server failure is a candidate", () => {
  const outcome = classifyAutoFixCase({
    errorReportVerification: "verified",
    errorClassificationSource: "server",
    clientErrorCode: null,
    evidenceAvailability: "recorded",
    evidence: { errorCode: "AI_PROVIDER_ERROR", retryable: false, httpStatus: 500 },
  });
  assert.equal(
    outcome.classification,
    AUTOFIX_CLASSIFICATION.applicationCandidate
  );
  assert.equal(outcome.eligible, true);
});

test("missing evidence classifies as evidence_incomplete", () => {
  const outcome = classifyAutoFixCase({
    errorReportVerification: "verified",
    errorClassificationSource: "server",
    clientErrorCode: null,
    evidenceAvailability: "not_yet_available",
    evidence: null,
  });
  assert.equal(
    outcome.classification,
    AUTOFIX_CLASSIFICATION.evidenceIncomplete
  );
  assert.equal(outcome.eligible, false);
});

test("collection backoff grows and is bounded", () => {
  assert.equal(autoFixCollectBackoffMs(1), 60_000);
  assert.equal(autoFixCollectBackoffMs(2), 5 * 60_000);
  assert.ok(
    autoFixCollectBackoffMs(AUTOFIX_MAX_COLLECT_ATTEMPTS) <=
      autoFixCollectBackoffMs(AUTOFIX_MAX_COLLECT_ATTEMPTS + 10),
    "past the table the backoff stays at its ceiling"
  );
  assert.equal(autoFixCollectBackoffMs(999), 120 * 60_000);
});

test("shadow mode is fail-closed behind the env flag", () => {
  const previous = process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
  try {
    delete process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
    assert.equal(isAutoFixShadowModeEnabled(), false);
    process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED = "1";
    assert.equal(isAutoFixShadowModeEnabled(), false, "only the literal 'true'");
    process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED = "true";
    assert.equal(isAutoFixShadowModeEnabled(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
    } else {
      process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED = previous;
    }
  }
});

// --- Phase 3 edges -----------------------------------------------------------

test("the Phase 3 happy path is allowed, and only via the graph", () => {
  const path = [
    AUTOFIX_CASE_STATE.awaitingHumanReview,
    AUTOFIX_CASE_STATE.fixAttempting,
    AUTOFIX_CASE_STATE.redGreenProven,
    AUTOFIX_CASE_STATE.prOpen,
    AUTOFIX_CASE_STATE.merged,
    AUTOFIX_CASE_STATE.stagingVerified,
    AUTOFIX_CASE_STATE.closed,
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.ok(
      canTransitionAutoFixCase(path[i], path[i + 1]),
      `${path[i]} -> ${path[i + 1]}`
    );
  }
  // No skipping: a proof cannot jump straight to merged, and an attempt
  // cannot open a PR without a validated proof.
  assert.ok(
    !canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.redGreenProven,
      AUTOFIX_CASE_STATE.merged
    )
  );
  assert.ok(
    !canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.fixAttempting,
      AUTOFIX_CASE_STATE.prOpen
    )
  );
  assert.ok(
    !canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.fixAttempting,
      AUTOFIX_CASE_STATE.stagingVerified
    )
  );
});

test("a died fix runner returns to the review pool, never forward", () => {
  assert.ok(
    canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.fixAttempting,
      AUTOFIX_CASE_STATE.awaitingHumanReview
    )
  );
  assert.ok(
    !canTransitionAutoFixCase(
      AUTOFIX_CASE_STATE.awaitingHumanReview,
      AUTOFIX_CASE_STATE.redGreenProven
    )
  );
});

test("the Phase 3 master switch is fail-closed and separate from shadow mode", () => {
  const previous = process.env.FEEDBACK_AUTOFIX_ENABLED;
  const previousShadow = process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
  try {
    delete process.env.FEEDBACK_AUTOFIX_ENABLED;
    process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED = "true";
    assert.equal(
      isAutoFixFixingEnabled(),
      false,
      "shadow mode alone never enables fixing"
    );
    process.env.FEEDBACK_AUTOFIX_ENABLED = "true";
    assert.equal(isAutoFixFixingEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.FEEDBACK_AUTOFIX_ENABLED;
    else process.env.FEEDBACK_AUTOFIX_ENABLED = previous;
    if (previousShadow === undefined) {
      delete process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED;
    } else {
      process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED = previousShadow;
    }
  }
});
