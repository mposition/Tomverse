import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_REVIEW_DISPLAY_MAX_BYTES,
  AMUX_REVIEW_PROPOSAL_TTL_MS,
  amuxReviewApprovalReadiness,
  amuxReviewApprovalHasEvidence,
  amuxReviewDisplayIsExact,
  amuxReviewTextExceedsDisplay,
  amuxReviewProposalExpiry,
  amuxReviewRequestDigest,
  amuxReviewSubjectDigest,
  amuxReviewTargetStatus,
  amuxV22ReviewRetryHasVerifiedOutcome,
  amuxV4ReviewEvidenceMatches,
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
  for (const uncertain of [
    { ...attempt, reason: "usage_outcome_unknown" },
    { ...attempt, outcome: "expired", reason: "outcome_unknown" },
    { ...attempt, v22AssignmentId: null },
  ]) assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
    sourceSystem: "admin-idea-v4", attempt: uncertain }), false);
  assert.equal(amuxV22ReviewRetryHasVerifiedOutcome({
    sourceSystem: "legacy", attempt: null }), true);
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

test("only the four approved task-review transitions exist", () => {
  assert.equal(amuxReviewTargetStatus("review", "approve"), "done");
  assert.equal(amuxReviewTargetStatus("review", "block"), "blocked");
  assert.equal(amuxReviewTargetStatus("blocked", "retry"), "todo");
  assert.equal(amuxReviewTargetStatus("blocked", "block"), "blocked");
  assert.equal(amuxReviewTargetStatus("review", "retry"), null);
  assert.equal(amuxReviewTargetStatus("blocked", "approve"), null);
});

test("proposal TTL is exactly 24 hours", () => {
  const issued = new Date("2026-09-21T00:00:00.000Z");
  assert.equal(AMUX_REVIEW_PROPOSAL_TTL_MS, 86_400_000);
  assert.equal(amuxReviewProposalExpiry(issued).toISOString(), "2026-09-22T00:00:00.000Z");
});
