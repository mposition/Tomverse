import assert from "node:assert/strict";
import test from "node:test";

import { amuxOwnerRecoveryPreparation } from
  "../lib/amux/ownerRecoveryCore.ts";

const prepare = (overrides = {}) => amuxOwnerRecoveryPreparation({
  escalationReason: "operator_review_required",
  lastAttemptReason: "reported_result",
  lastAttemptOutcome: "blocked",
  lastAttemptToStatus: "blocked",
  lastAttemptEndedAt: "2026-10-12T01:00:00.000Z",
  assignmentConnected: true,
  workerReportConnected: true,
  workerReportVerified: true,
  artifactConnected: false,
  serverAllowsRetry: true,
  ...overrides,
});

test("legacy local done and closed flags do not stand in for execution or output evidence", () => {
  for (const reason of ["local_card_done", "local_card_closed"]) {
    assert.deepEqual(prepare({
      lastAttemptReason: reason,
      lastAttemptOutcome: reason === "local_card_done" ? "succeeded" : "blocked",
      workerReportConnected: false,
      workerReportVerified: false,
    }), {
      reason,
      assignmentConnected: true,
      executionOutcomeKnown: false,
      outputState: "missing",
      decisionContextReady: false,
      retryPreviewReady: false,
      missingEvidence: ["execution_outcome", "worker_output"],
    });
  }
});

test("expired lease and unknown outcome never expose retry preparation", () => {
  for (const input of [
    { escalationReason: "execution_lease_expired", lastAttemptReason: "reported_result" },
    { lastAttemptReason: "usage_outcome_unknown", lastAttemptOutcome: "expired",
      lastAttemptToStatus: "blocked" },
    { lastAttemptReason: "outcome_unknown", lastAttemptOutcome: "blocked" },
  ]) {
    const result = prepare(input);
    assert.equal(result.executionOutcomeKnown, false);
    assert.equal(result.decisionContextReady, false);
    assert.equal(result.retryPreviewReady, false);
    assert.ok(result.missingEvidence.includes("execution_outcome"));
  }
});

test("only protected terminal outcome and target pairs count as known execution", () => {
  for (const input of [
    { lastAttemptOutcome: "started", lastAttemptToStatus: null,
      lastAttemptEndedAt: null },
    { lastAttemptOutcome: "running", lastAttemptToStatus: "blocked" },
    { lastAttemptOutcome: "arbitrary-terminal", lastAttemptToStatus: "blocked" },
    { lastAttemptOutcome: "succeeded", lastAttemptToStatus: "todo" },
    { lastAttemptOutcome: "blocked", lastAttemptToStatus: "blocked",
      lastAttemptEndedAt: null },
  ]) {
    const result = prepare(input);
    assert.equal(result.executionOutcomeKnown, false);
    assert.equal(result.decisionContextReady, false);
    assert.equal(result.retryPreviewReady, false);
    assert.ok(result.missingEvidence.includes("execution_outcome"));
  }

  assert.equal(prepare({
    lastAttemptOutcome: "succeeded",
    lastAttemptToStatus: "review",
  }).executionOutcomeKnown, true);
  assert.equal(prepare({
    lastAttemptOutcome: "failed",
    lastAttemptToStatus: "todo",
  }).executionOutcomeKnown, true);
});

test("existing retry preparation requires server permission and bound decision evidence", () => {
  assert.deepEqual(prepare(), {
    reason: "terminal_recorded",
    assignmentConnected: true,
    executionOutcomeKnown: true,
    outputState: "verified",
    decisionContextReady: true,
    retryPreviewReady: true,
    missingEvidence: [],
  });
  assert.equal(prepare({ serverAllowsRetry: false }).retryPreviewReady, false);
  const withoutAssignment = prepare({ assignmentConnected: false, artifactConnected: true });
  assert.equal(withoutAssignment.decisionContextReady, false);
  assert.equal(withoutAssignment.retryPreviewReady, false);
  assert.equal(prepare({
    workerReportConnected: false,
    workerReportVerified: false,
  }).retryPreviewReady, false);
});

test("connected but unverified output is reported honestly without fabricating absence", () => {
  const result = prepare({ workerReportVerified: false });
  assert.equal(result.outputState, "unverified");
  assert.equal(result.decisionContextReady, true);
  assert.equal(result.retryPreviewReady, false);
  assert.equal(result.missingEvidence.includes("worker_output"), false);
});

test("a protected terminal block keeps decision context without result evidence", () => {
  const result = prepare({
    workerReportConnected: false,
    workerReportVerified: false,
  });
  assert.equal(result.executionOutcomeKnown, true);
  assert.equal(result.outputState, "missing");
  assert.equal(result.decisionContextReady, true);
  assert.equal(result.retryPreviewReady, false);
  assert.deepEqual(result.missingEvidence, ["worker_output"]);
});
