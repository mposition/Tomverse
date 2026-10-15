import assert from "node:assert/strict";
import test from "node:test";

import {
  ENGINEERING_AGENT_PR_APPROVER_IDS,
  decideEngineeringAgentMergedPr,
  decideEngineeringAgentPrApproval,
} from "../lib/engineeringAgentPrApprovalCore.ts";
import { ENGINEERING_AGENT_NOT_APPROVED_REASONS } from "../lib/engineeringAgentCore.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OWNER = 60078951;
const recordedAt = new Date("2026-10-15T05:00:00Z");
const after = new Date("2026-10-15T06:00:00Z");

const input = (overrides = {}) => ({
  baseRef: "develop",
  headSha: HEAD,
  verifiedHeadSha: HEAD,
  requiredChecks: { allPassed: true },
  reviews: [{ id: 10, userId: OWNER, state: "APPROVED", commitId: HEAD, submittedAt: after }],
  snapshot: { baseSha: BASE, diffDigest: "d".repeat(64), recordedAt, invalidatedReviewIds: [] },
  current: { baseSha: BASE, diffDigest: "d".repeat(64) },
  ...overrides,
});

test("the approver list is the policy's: mposition by numeric id", () => {
  assert.deepEqual(ENGINEERING_AGENT_PR_APPROVER_IDS, [OWNER]);
});

test("all seven conditions approve, and the verdict names the review", () => {
  assert.deepEqual(decideEngineeringAgentPrApproval(input()), {
    verdict: "approved", reviewId: 10, reviewerId: OWNER, reviewCommitId: HEAD, submittedAt: after,
  });
});

test("each failed condition gives its own policy reason", () => {
  const reason = (overrides) => decideEngineeringAgentPrApproval(input(overrides));
  assert.deepEqual(reason({ baseRef: "main" }), { verdict: "not_approved", reason: "base_not_develop" });
  assert.deepEqual(reason({ headSha: "c".repeat(40) }), { verdict: "not_approved", reason: "head_not_verified" });
  assert.deepEqual(reason({ requiredChecks: { allPassed: false } }), { verdict: "not_approved", reason: "required_check_failed" });
  assert.deepEqual(reason({ current: { baseSha: "e".repeat(40), diffDigest: "d".repeat(64) } }),
    { verdict: "not_approved", reason: "snapshot_changed" });
  assert.deepEqual(reason({ current: { baseSha: BASE, diffDigest: "f".repeat(64) } }),
    { verdict: "not_approved", reason: "snapshot_changed" });
  assert.deepEqual(reason({ reviews: [] }), { verdict: "not_approved", reason: "no_authorised_review" });
  assert.deepEqual(reason({ reviews: [{ id: 11, userId: 1, state: "APPROVED", commitId: HEAD, submittedAt: after }] }),
    { verdict: "not_approved", reason: "no_authorised_review" });
  assert.deepEqual(reason({ snapshot: { ...input().snapshot, invalidatedReviewIds: [10] } }),
    { verdict: "not_approved", reason: "review_not_valid" });
  assert.deepEqual(reason({ reviews: [{ id: 10, userId: OWNER, state: "APPROVED", commitId: "c".repeat(40), submittedAt: after }] }),
    { verdict: "not_approved", reason: "review_not_valid" });
  assert.deepEqual(reason({ reviews: [{ id: 10, userId: OWNER, state: "APPROVED", commitId: HEAD, submittedAt: recordedAt }] }),
    { verdict: "not_approved", reason: "review_before_snapshot" });
  for (const value of [
    reason({ baseRef: "main" }), reason({ headSha: "c".repeat(40) }), reason({ reviews: [] }),
  ]) assert.ok(ENGINEERING_AGENT_NOT_APPROVED_REASONS.includes(value.reason));
});

test("a read that could not complete decides nothing", () => {
  assert.deepEqual(decideEngineeringAgentPrApproval(input({ requiredChecks: null })),
    { verdict: "undetermined", reason: "checks_unreadable" });
  assert.deepEqual(decideEngineeringAgentPrApproval(input({ current: null })),
    { verdict: "undetermined", reason: "snapshot_unreadable" });
});

test("a later change request withdraws an approval; a bare comment does not", () => {
  const later = new Date("2026-10-15T07:00:00Z");
  assert.deepEqual(decideEngineeringAgentPrApproval(input({ reviews: [
    { id: 10, userId: OWNER, state: "APPROVED", commitId: HEAD, submittedAt: after },
    { id: 12, userId: OWNER, state: "CHANGES_REQUESTED", commitId: HEAD, submittedAt: later },
  ] })), { verdict: "not_approved", reason: "no_authorised_review" });
  assert.equal(decideEngineeringAgentPrApproval(input({ reviews: [
    { id: 10, userId: OWNER, state: "APPROVED", commitId: HEAD, submittedAt: after },
    { id: 13, userId: OWNER, state: "COMMENTED", commitId: HEAD, submittedAt: later },
  ] })).verdict, "approved");
});

test("a merge counts only after an approval recorded before it", () => {
  assert.equal(decideEngineeringAgentMergedPr({ merged: false, approvalRecordedBeforeMerge: false }), "open");
  assert.equal(decideEngineeringAgentMergedPr({ merged: true, approvalRecordedBeforeMerge: true }), "done");
  assert.equal(decideEngineeringAgentMergedPr({ merged: true, approvalRecordedBeforeMerge: false }), "merged_without_approval");
});
