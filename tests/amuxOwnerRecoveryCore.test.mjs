import assert from "node:assert/strict";
import test from "node:test";

import { amuxOwnerRecoveryPreparation } from
  "../lib/amux/ownerRecoveryCore.ts";

const prepare = (overrides = {}) => amuxOwnerRecoveryPreparation({
  taskStatus: "blocked",
  taskRevision: 8,
  escalationReason: "operator_review_required",
  lastAttemptReason: "reported_result",
  lastAttemptTaskRevision: 7,
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
      approvalExecutionSourceReady: false,
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
    { lastAttemptOutcome: "failed", lastAttemptToStatus: "blocked",
      lastAttemptReason: "execution_failed" },
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
  for (const lastAttemptReason of ["attempt_budget_exhausted", "attempts"]) {
    assert.equal(prepare({
      escalationReason: "execution_blocked",
      lastAttemptOutcome: "failed",
      lastAttemptToStatus: "blocked",
      lastAttemptReason,
    }).executionOutcomeKnown, true);
  }
});

test("an exact no-attempt human review preserves block context without inventing execution", () => {
  const result = prepare({
    escalationReason: "human_review_required",
    lastAttemptReason: null,
    lastAttemptTaskRevision: null,
    lastAttemptOutcome: null,
    lastAttemptToStatus: null,
    lastAttemptEndedAt: null,
    workerReportConnected: false,
    workerReportVerified: false,
  });
  assert.equal(result.assignmentConnected, true);
  assert.equal(result.executionOutcomeKnown, false);
  assert.equal(result.reason, "evidence_missing");
  assert.equal(result.decisionContextReady, true);
  assert.equal(result.approvalExecutionSourceReady, false);
  assert.equal(result.retryPreviewReady, false);
  assert.deepEqual(result.missingEvidence,
    ["execution_outcome", "worker_output"]);

  for (const overrides of [
    { assignmentConnected: false },
    { taskStatus: "review" },
    { escalationReason: "canonical_deadline_review_required" },
    { lastAttemptTaskRevision: 7 },
    { lastAttemptOutcome: "running" },
  ]) {
    const unsupported = prepare({
      escalationReason: "human_review_required",
      lastAttemptReason: null,
      lastAttemptTaskRevision: null,
      lastAttemptOutcome: null,
      lastAttemptToStatus: null,
      lastAttemptEndedAt: null,
      ...overrides,
    });
    assert.equal(unsupported.executionOutcomeKnown, false);
    assert.equal(unsupported.decisionContextReady, false);
    assert.equal(unsupported.retryPreviewReady, false);
  }
});

test("approval execution source matches the backend review attempt exactly", () => {
  const approved = prepare({
    taskStatus: "review",
    lastAttemptOutcome: "succeeded",
    lastAttemptToStatus: "review",
  });
  assert.equal(approved.approvalExecutionSourceReady, true);

  for (const overrides of [
    { assignmentConnected: false },
    { taskStatus: "blocked" },
    { lastAttemptReason: "outcome_unknown" },
    { lastAttemptEndedAt: null },
    { lastAttemptOutcome: "succeeded", lastAttemptToStatus: "done" },
    { lastAttemptOutcome: "failed", lastAttemptToStatus: "todo" },
    { escalationReason: "execution_blocked", lastAttemptReason: "attempts",
      lastAttemptOutcome: "failed", lastAttemptToStatus: "blocked" },
    { lastAttemptOutcome: "blocked", lastAttemptToStatus: "blocked" },
    { lastAttemptTaskRevision: 8 },
    { lastAttemptTaskRevision: 8.5 },
    { taskRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.equal(prepare({
      taskStatus: "review",
      lastAttemptOutcome: "succeeded",
      lastAttemptToStatus: "review",
      ...overrides,
    }).approvalExecutionSourceReady, false);
  }
});

test("existing retry preparation requires server permission and bound decision evidence", () => {
  assert.deepEqual(prepare(), {
    reason: "terminal_recorded",
    assignmentConnected: true,
    executionOutcomeKnown: true,
    outputState: "verified",
    decisionContextReady: true,
    approvalExecutionSourceReady: false,
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
