import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_REVIEW_DISPLAY_MAX_BYTES,
  AMUX_REVIEW_PROPOSAL_TTL_MS,
  AMUX_REVIEW_PUBLICATION_PENDING_STATES,
  amuxReviewAllowedOutcomes,
  amuxReviewApprovalReadiness,
  amuxReviewApprovalHasEvidence,
  amuxReviewDisplayIsExact,
  amuxReviewTextExceedsDisplay,
  amuxReviewProposalExpiry,
  amuxReviewRequestDigest,
  amuxReviewSubjectDigest,
  amuxReviewPublicationMayOpenPr,
  amuxReviewTargetStatus,
  amuxV22PrlessReviewRetryAllowed,
  amuxV22ReviewRetryHasVerifiedOutcome,
  amuxV4ReviewEvidenceMatches,
  amuxV4ReviewReportProjection,
  isAmuxAgentApprovalEnabled,
} from "../lib/amux/reviewApprovalCore.ts";

const subject = {
  escalation_id: "escalation",
  task_id: "task",
  task_revision: 7,
  task_status: "blocked",
  title: "Investigate worker refusal",
  description: null,
  due_parse_state: "valid",
  due_at: "2026-09-22T00:00:00.000Z",
  escalation_specialty: "execution-recovery",
  escalation_reason: "Worker reported a blocked execution.",
  last_attempt_id: "attempt",
  last_attempt_revision: 6,
  last_attempt_outcome: "blocked",
  last_attempt_to_status: "blocked",
  last_attempt_reason: "worker_reported_blocked",
  previous_block_reason: null,
  review_pr_number: null,
  review_base_sha: null,
  review_head_sha: null,
  review_diff_digest: null,
};

test("approval flag is enabled by one exact value only", () => {
  for (const value of [undefined, "", "TRUE", "1", "true ", "false"]) {
    assert.equal(isAmuxAgentApprovalEnabled(value), false);
  }
  assert.equal(isAmuxAgentApprovalEnabled("true"), true);
});

test("v22 unknown execution cannot be manually requeued without a verified terminal receipt", () => {
  const attempt = { v22AssignmentId: "assignment", outcome: "blocked",
    toStatus: "blocked", reason: "reported_result" };
  assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
    sourceSystem: "admin-idea-v4", attempt }), true);
  // A CLI failure whose cause the CLI named is known (owner decision 2026-11-06).
  for (const reason of ["cli_turn_limit", "cli_execution_error", "cli_budget_limit"])
    assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
      sourceSystem: "admin-idea-v4", attempt: { ...attempt, reason } }), true);
  for (const uncertain of [
    { ...attempt, reason: null },
    { ...attempt, reason: "cli_unknown" },
    { ...attempt, reason: "cli_turn_limit", outcome: "failed" },
    { ...attempt, reason: "usage_outcome_unknown" },
    { ...attempt, outcome: "expired", reason: "outcome_unknown" },
    { ...attempt, v22AssignmentId: null },
  ]) assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
    sourceSystem: "admin-idea-v4", attempt: uncertain }), false);
  assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
    sourceSystem: "legacy", attempt: null }), true);
});

test("an expired v22 attempt may be retried only when the server stored its own final result", () => {
  const expired = { id: "attempt-1", v22AssignmentId: "assignment",
    outcome: "expired", toStatus: "blocked", reason: "outcome_unknown" };
  assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({ sourceSystem: "admin-idea-v4",
    attempt: expired, storedResultAttemptId: "attempt-1" }), true);
  for (const [attempt, storedResultAttemptId] of [
    [expired, null],
    [expired, undefined],
    [expired, "attempt-0"],
    [{ ...expired, id: undefined }, undefined],
    [{ ...expired, id: "" }, ""],
    [{ ...expired, v22AssignmentId: null }, "attempt-1"],
    [{ ...expired, toStatus: "todo" }, "attempt-1"],
    [{ ...expired, outcome: "failed" }, "attempt-1"],
    [{ ...expired, outcome: null }, "attempt-1"],
  ]) assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({ sourceSystem: "admin-idea-v4",
    attempt, storedResultAttemptId }), false, JSON.stringify({ attempt, storedResultAttemptId }));
});

test("a run the v52 review rejected twice may be retried only with its own reject record", () => {
  // Owner decision 2026-11-07 (AMUX-ROUTERFAIL-004): the run finished with a
  // patch and a recorded verdict; only the one automatic return was used up.
  const rejected = { id: "attempt-2", v22AssignmentId: "assignment",
    outcome: "succeeded", toStatus: "blocked",
    reason: "review_server_rejected_twice" };
  assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({ sourceSystem: "admin-idea-v4",
    attempt: rejected, rejectedReviewAttemptId: "attempt-2" }), true);
  for (const [attempt, rejectedReviewAttemptId] of [
    [rejected, null],
    [rejected, undefined],
    [rejected, "attempt-1"],
    [{ ...rejected, id: undefined }, undefined],
    [{ ...rejected, id: "" }, ""],
    [{ ...rejected, v22AssignmentId: null }, "attempt-2"],
    [{ ...rejected, toStatus: "review" }, "attempt-2"],
    [{ ...rejected, outcome: "blocked" }, "attempt-2"],
    [{ ...rejected, outcome: "expired" }, "attempt-2"],
    // A review whose result is not known stays closed.
    [{ ...rejected, reason: "review_server_unknown" }, "attempt-2"],
    [{ ...rejected, reason: "review_history_unavailable" }, "attempt-2"],
    [{ ...rejected, reason: "review_server_unknown", outcome: "blocked" }, "attempt-2"],
    [{ ...rejected, reason: "review_server_rejected" }, "attempt-2"],
  ]) assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({ sourceSystem: "admin-idea-v4",
    attempt, rejectedReviewAttemptId }), false,
  JSON.stringify({ attempt, rejectedReviewAttemptId }));
});

test("approval readiness is conditional and names missing settings without values", () => {
  assert.deepEqual(amuxReviewApprovalReadiness({}), { ready: true, enabled: false, missing: [] });
  assert.deepEqual(amuxReviewApprovalReadiness({
    RAILWAY_PRIVATE_DOMAIN: "tomverse.railway.internal",
    PORT: "8080",
    TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: "http://sibling.railway.internal:8080",
  }), {
    ready: false,
    enabled: false,
    missing: ["TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN"],
  });
  assert.deepEqual(amuxReviewApprovalReadiness({ TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED: "true" }), {
    ready: false,
    enabled: true,
    missing: ["TOMVERSE_AMUX_SYNC_SECRET", "AMUX_REVIEW_GITHUB_READ_TOKEN", "NEXTAUTH_URL"],
  });
  assert.deepEqual(amuxReviewApprovalReadiness({
    TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED: "true",
    TOMVERSE_AMUX_SYNC_SECRET: "s".repeat(32),
    AMUX_REVIEW_GITHUB_READ_TOKEN: "token",
    NEXTAUTH_URL: "https://example.test",
  }), { ready: true, enabled: true, missing: [] });

  assert.deepEqual(amuxReviewApprovalReadiness({
    TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED: "true",
    TOMVERSE_AMUX_SYNC_SECRET: "s".repeat(32),
    AMUX_REVIEW_GITHUB_READ_TOKEN: "token",
    NEXTAUTH_URL: "https://example.test",
    RAILWAY_PRIVATE_DOMAIN: "tomverse.railway.internal",
    PORT: "8080",
    TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: "http://tomverse.railway.internal:8080",
  }), { ready: true, enabled: true, missing: [] });

  assert.deepEqual(amuxReviewApprovalReadiness({
    TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED: "true",
    TOMVERSE_AMUX_SYNC_SECRET: "s".repeat(32),
    AMUX_REVIEW_GITHUB_READ_TOKEN: "token",
    NEXTAUTH_URL: "https://example.test",
    RAILWAY_PRIVATE_DOMAIN: "tomverse.railway.internal",
    PORT: "8080",
    TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: "http://sibling.railway.internal:8080",
  }), {
    ready: false,
    enabled: true,
    missing: ["TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN"],
  });
});

test("multibyte ingress text is not mistaken for a 50k-byte display limit", () => {
  assert.equal(AMUX_REVIEW_DISPLAY_MAX_BYTES, 200_000);
  assert.equal(amuxReviewTextExceedsDisplay("한".repeat(50_000)), false);
  assert.equal(amuxReviewTextExceedsDisplay("x".repeat(200_001)), true);
  assert.equal(amuxReviewTextExceedsDisplay("제".repeat(100_000)), true);
  assert.equal(amuxReviewTextExceedsDisplay(null), false);
});

test("v4 report projection separates the digest-bound assignment and worker report", () => {
  const evidence = {
    scopeAndCompletionCriteria: "Deliver the owner review.",
    approvedBrief: "Keep decisions inside the existing server authority.",
    workerReport: "Implemented and verified the report view.",
  };
  assert.deepEqual(amuxV4ReviewReportProjection({
    contentValid: true,
    evidence,
    workerReportVerified: true,
  }), {
    scope_and_completion_criteria: evidence.scopeAndCompletionCriteria,
    approved_execution_brief: evidence.approvedBrief,
    worker_report: evidence.workerReport,
    worker_report_verified: true,
  });
  assert.equal(amuxV4ReviewReportProjection({
    contentValid: false,
    evidence,
    workerReportVerified: true,
  }), null);
  assert.deepEqual(amuxV4ReviewReportProjection({
    contentValid: true,
    evidence: { ...evidence, workerReport: null },
    workerReportVerified: true,
  }), {
    scope_and_completion_criteria: evidence.scopeAndCompletionCriteria,
    approved_execution_brief: evidence.approvedBrief,
    worker_report: null,
    worker_report_verified: false,
  });
});

test("subject digest binds content and does not depend on caller key insertion order", () => {
  const digest = amuxReviewSubjectDigest(subject);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    digest,
    amuxReviewSubjectDigest(Object.fromEntries(Object.entries(subject).reverse())),
  );
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, task_revision: 8 }));
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, description: "new" }));
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, previous_block_reason: "A human blocked this task." }));
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, review_pr_number: 1594 }));
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, review_base_sha: "c".repeat(40) }));
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, review_head_sha: "a".repeat(40) }));
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, review_diff_digest: "b".repeat(64) }));
});

test("v4 review digest binds private evidence without changing legacy review digests", () => {
  const evidence = { title_digest: "a".repeat(64), body_digest: "b".repeat(64),
    brief_digest: "c".repeat(64), result_attempt_id: "attempt-2",
    result_sha256: "d".repeat(64) };
  const legacy = amuxReviewSubjectDigest(subject);
  const v4 = amuxReviewSubjectDigest({ ...subject, v4_evidence: evidence });
  assert.notEqual(v4, legacy);
  assert.equal(amuxReviewSubjectDigest(subject), legacy);
  assert.notEqual(v4, amuxReviewSubjectDigest({ ...subject,
    v4_evidence: { ...evidence, result_sha256: "e".repeat(64) } }));
});

test("a PR-less v4 non-code result may be approved only with verified full evidence", () => {
  const base = { sourceSystem: "admin-idea-v4", cardType: "task",
    taskRole: "design", reviewPrNumber: null,
    artifactAvailable: false, v4EvidenceVerified: true,
    displayTruncated: false, displayExact: true };
  assert.equal(amuxReviewApprovalHasEvidence(base), true);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, v4EvidenceVerified: false }), false);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, displayTruncated: true }), false);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, displayExact: false }), false);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, taskRole: "implement" }), false);
  // A test Task leaves a patch, so only its pull request completes it.
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, taskRole: "test" }), false);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, taskRole: "test",
    reviewPrNumber: 123, artifactAvailable: true, v4EvidenceVerified: false }), true);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, taskRole: "verify" }), true);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, taskRole: "implement",
    reviewPrNumber: 123, artifactAvailable: true,
    v4EvidenceVerified: false }), true);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, reviewPrNumber: 123 }), false);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, cardType: "story" }), false);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, taskRole: null }), false);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, sourceSystem: "legacy" }), false);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, sourceSystem: "legacy",
    artifactAvailable: true, displayExact: true }), true);
  assert.equal(amuxReviewApprovalHasEvidence({ ...base, sourceSystem: "legacy",
    artifactAvailable: true, displayExact: false }), false);
});

test("approval is closed when the owner display would hide source characters", () => {
  assert.equal(amuxReviewDisplayIsExact("plain Korean 한국어"), true);
  assert.equal(amuxReviewDisplayIsExact("x".repeat(AMUX_REVIEW_DISPLAY_MAX_BYTES + 1)), true);
  for (const hidden of ["x\u202ey", "x\u200by", "x\u0001y", "x\r\ny",
    "e\u0301", "x\ud800y"]) {
    assert.equal(amuxReviewDisplayIsExact(hidden), false);
  }
});

test("v4 completion evidence is tied to the exact card revision and latest retained attempt", () => {
  const input = {
    task: { id: "card", sourceSystem: "admin-idea-v4", revision: 4,
      titleDigest: "a", bodyDigest: "b", briefDigest: "c" },
    evidence: { taskId: "card", revision: 4, titleDigest: "a",
      bodyDigest: "b", briefDigest: "c", resultAttemptId: "attempt",
      resultSha256: "d" },
    result: { attemptId: "attempt", sourceSha256: "d", bodyPurgedAt: null },
    attempt: { id: "attempt", v22AssignmentId: "assignment" },
  };
  assert.equal(amuxV4ReviewEvidenceMatches(input), true);
  assert.equal(amuxV4ReviewEvidenceMatches({ ...input,
    evidence: { ...input.evidence, bodyDigest: "changed" } }), false);
  assert.equal(amuxV4ReviewEvidenceMatches({ ...input,
    result: { ...input.result, sourceSha256: "changed" } }), false);
  assert.equal(amuxV4ReviewEvidenceMatches({ ...input,
    result: { ...input.result, bodyPurgedAt: new Date() } }), false);
  assert.equal(amuxV4ReviewEvidenceMatches({ ...input,
    attempt: { ...input.attempt, v22AssignmentId: null } }), false);
  assert.equal(amuxV4ReviewEvidenceMatches({ ...input,
    task: { ...input.task, revision: 5 } }), false);
});

test("request digest binds proposal, key, and resolution", () => {
  const input = {
    proposal_id: "proposal",
    idempotency_key: "same-key",
    resolution: "Operator reviewed the corrected source.",
  };
  const digest = amuxReviewRequestDigest(input);
  assert.notEqual(digest, amuxReviewRequestDigest({ ...input, resolution: "different" }));
  assert.notEqual(digest, amuxReviewRequestDigest({ ...input, proposal_id: "other" }));
});

test("only the five approved task-review transitions exist", () => {
  assert.equal(amuxReviewTargetStatus("review", "approve"), "done");
  assert.equal(amuxReviewTargetStatus("review", "block"), "blocked");
  // A v22 result with no pull request (owner decision 2026-11-08).
  assert.equal(amuxReviewTargetStatus("review", "retry"), "todo");
  assert.equal(amuxReviewTargetStatus("blocked", "retry"), "todo");
  assert.equal(amuxReviewTargetStatus("blocked", "block"), "blocked");
  assert.equal(amuxReviewTargetStatus("blocked", "approve"), null);
});

const prlessImplement = {
  sourceSystem: "admin-idea-v4", cardType: "task", reviewPrNumber: null,
  attempt: { v22AssignmentId: "assignment", outcome: "succeeded", toStatus: "review",
    reason: "reported_result" },
  v4EvidenceVerified: true, publicationMayOpenPr: false,
  displayTruncated: false, displayExact: true,
};

test("a v22 result in review with no pull request may be run again", () => {
  assert.equal(amuxV22PrlessReviewRetryAllowed(prlessImplement), true);
  for (const [field, value] of [
    ["sourceSystem", "legacy"], ["cardType", "idea"], ["reviewPrNumber", 3501],
    ["v4EvidenceVerified", false], ["publicationMayOpenPr", true],
    ["displayTruncated", true], ["displayExact", false], ["attempt", null],
  ]) {
    assert.equal(amuxV22PrlessReviewRetryAllowed({ ...prlessImplement, [field]: value }),
      false, field);
  }
  for (const attempt of [
    { ...prlessImplement.attempt, v22AssignmentId: null },
    { ...prlessImplement.attempt, outcome: "expired" },
    { ...prlessImplement.attempt, toStatus: "blocked" },
    // Its usage was never reported (AMUX-AGENTOPS-001): block only.
    { ...prlessImplement.attempt, reason: "usage_outcome_unknown" },
  ]) {
    assert.equal(amuxV22PrlessReviewRetryAllowed({ ...prlessImplement, attempt }), false);
  }
});

test("publication that has opened or may still open the PR holds the retry", () => {
  const tierPending = "tier_pending";
  assert.equal(amuxReviewPublicationMayOpenPr([], tierPending), false);
  for (const state of AMUX_REVIEW_PUBLICATION_PENDING_STATES) {
    assert.equal(amuxReviewPublicationMayOpenPr(
      [{ kind: "publish", state, reason: null }], tierPending), true, state);
  }
  for (const state of ["publish_refused", "publish_failed", "expired"]) {
    assert.equal(amuxReviewPublicationMayOpenPr(
      [{ kind: "publish", state, reason: null }], tierPending), false, state);
  }
  assert.equal(amuxReviewPublicationMayOpenPr(
    [{ kind: "t2_draft", state: "open", reason: tierPending }], tierPending), true);
  // A draft kept private (T2 with the review switch off, no tier evidence).
  for (const reason of ["tier_two", "tier_evidence_unavailable", "publish_refused"]) {
    assert.equal(amuxReviewPublicationMayOpenPr(
      [{ kind: "t2_draft", state: "open", reason }], tierPending), false, reason);
  }
  assert.equal(amuxReviewPublicationMayOpenPr(
    [{ kind: "t2_draft", state: "resolved", reason: tierPending }], tierPending), false);
});

const outcomeInput = {
  eligible: true, taskStatus: "review", reviewAttempt: true,
  approvalHasEvidence: false, prlessRetryAllowed: false,
  blockedRetryVerified: false, budgetAllowed: true, dueCorrected: true,
  displayTruncated: false, displayExact: true,
};

test("review with no pull request offers block and retry, never approve", () => {
  // AMUX-FILEGEN-003: an implement Task whose result has no PR.
  assert.deepEqual(amuxReviewAllowedOutcomes({ ...outcomeInput,
    prlessRetryAllowed: true }), ["block", "retry"]);
  // The retry keeps the attempt budget, due date and exact display gates.
  for (const [field, value] of [["budgetAllowed", false], ["dueCorrected", false],
    ["displayTruncated", true], ["displayExact", false]]) {
    assert.deepEqual(amuxReviewAllowedOutcomes({ ...outcomeInput,
      prlessRetryAllowed: true, [field]: value }), ["block"], field);
  }
  // Without the PR-less evidence, review still offers block alone.
  assert.deepEqual(amuxReviewAllowedOutcomes(outcomeInput), ["block"]);
  // A blocked-path verdict never opens a retry from review.
  assert.deepEqual(amuxReviewAllowedOutcomes({ ...outcomeInput,
    blockedRetryVerified: true }), ["block"]);
});

test("review with a pull request and the blocked path are unchanged", () => {
  assert.deepEqual(amuxReviewAllowedOutcomes({ ...outcomeInput,
    approvalHasEvidence: true }), ["approve", "block"]);
  assert.deepEqual(amuxReviewAllowedOutcomes({ ...outcomeInput,
    reviewAttempt: false, approvalHasEvidence: true, prlessRetryAllowed: true }), []);
  const blocked = { ...outcomeInput, taskStatus: "blocked" };
  assert.deepEqual(amuxReviewAllowedOutcomes(blocked), ["block"]);
  assert.deepEqual(amuxReviewAllowedOutcomes({ ...blocked,
    blockedRetryVerified: true }), ["block", "retry"]);
  // A PR-less review verdict never opens a retry from blocked, nor approve.
  assert.deepEqual(amuxReviewAllowedOutcomes({ ...blocked,
    prlessRetryAllowed: true, approvalHasEvidence: true }), ["block"]);
  assert.deepEqual(amuxReviewAllowedOutcomes({ ...blocked,
    blockedRetryVerified: true, budgetAllowed: false }), ["block"]);
  assert.deepEqual(amuxReviewAllowedOutcomes({ ...blocked, eligible: false,
    blockedRetryVerified: true }), []);
  assert.deepEqual(amuxReviewAllowedOutcomes({ ...outcomeInput, taskStatus: "todo" }), []);
});

test("proposal TTL is exactly 24 hours", () => {
  const issued = new Date("2026-09-21T00:00:00.000Z");
  assert.equal(AMUX_REVIEW_PROPOSAL_TTL_MS, 86_400_000);
  assert.equal(amuxReviewProposalExpiry(issued).toISOString(), "2026-09-22T00:00:00.000Z");
});
