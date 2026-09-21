import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_REVIEW_DISPLAY_MAX_BYTES,
  AMUX_REVIEW_PROPOSAL_TTL_MS,
  amuxReviewApprovalReadiness,
  amuxReviewTextExceedsDisplay,
  amuxReviewProposalExpiry,
  amuxReviewRequestDigest,
  amuxReviewSubjectDigest,
  amuxReviewTargetStatus,
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

test("approval readiness is conditional and names missing settings without values", () => {
  assert.deepEqual(amuxReviewApprovalReadiness({}), { ready: true, enabled: false, missing: [] });
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
});

test("multibyte ingress text is not mistaken for a 50k-byte display limit", () => {
  assert.equal(AMUX_REVIEW_DISPLAY_MAX_BYTES, 200_000);
  assert.equal(amuxReviewTextExceedsDisplay("한".repeat(50_000)), false);
  assert.equal(amuxReviewTextExceedsDisplay("x".repeat(200_001)), true);
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
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, review_pr_number: 1594 }));
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, review_base_sha: "c".repeat(40) }));
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, review_head_sha: "a".repeat(40) }));
  assert.notEqual(digest, amuxReviewSubjectDigest({ ...subject, review_diff_digest: "b".repeat(64) }));
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
