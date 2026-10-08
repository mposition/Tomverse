import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V4_IDEA_READBACK_CODE_LATCH,
  AMUX_V4_IDEA_SUBMISSION_CODE_LATCH,
  ideaSubmissionReadBackPermitted,
  ideaSubmissionWritePermitted,
  inspectAmuxIdeaSubmission,
  isIdeaRequestIdUniqueViolation,
  submissionFailureKind,
} from "../lib/amux/ideaSubmissionCore.ts";

const requestId = "e7def5f0-2c78-4bd3-9558-ab8a8e3617d0";
const input = { version: 1, idea: "합성 아이디어", repositories: [], pullRequests: [] };
const submission = (extra = {}) => JSON.stringify({ version: 1, requestId, input, ...extra });

test("submission parser accepts only a bounded exact v4 envelope", () => {
  const result = inspectAmuxIdeaSubmission(submission());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.requestId, requestId);
    assert.equal(result.input.idea, input.idea);
    assert.equal(result.counts.repositoryCount, 0);
  }
  assert.deepEqual(inspectAmuxIdeaSubmission(submission({ extra: 1 })), { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSubmission(submission({ requestId: "not-a-uuid" })), { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSubmission(submission({ input: { ...input, unexpected: 1 } })), { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSubmission(submission({ input: { ...input, idea: "" } })), { ok: false, code: "metadata_incomplete" });
  assert.deepEqual(inspectAmuxIdeaSubmission("{").code, "schema_rejected");
});

test("v4 submission and read-back require their separate environment gates", () => {
  assert.equal(AMUX_V4_IDEA_SUBMISSION_CODE_LATCH, true);
  assert.equal(ideaSubmissionWritePermitted(undefined), false);
  assert.equal(ideaSubmissionWritePermitted("disabled"), false);
  assert.equal(ideaSubmissionWritePermitted("enabled"), true);
  assert.equal(AMUX_V4_IDEA_READBACK_CODE_LATCH, true);
  assert.equal(ideaSubmissionReadBackPermitted(undefined), false);
  assert.equal(ideaSubmissionReadBackPermitted("enabled"), true);
});

test("only a request-id unique conflict is labeled already seen", () => {
  const exact = { code: "P2002", meta: { modelName: "AmuxIdeaSubmission", target: ["requestId"] } };
  assert.equal(isIdeaRequestIdUniqueViolation(exact), true);
  assert.equal(isIdeaRequestIdUniqueViolation({ ...exact, meta: { modelName: "AdminAuditLog", target: ["requestId"] } }), false);
  assert.equal(isIdeaRequestIdUniqueViolation({ ...exact, meta: { modelName: "AmuxIdeaSubmission", target: ["id"] } }), false);
  assert.equal(submissionFailureKind(false, exact), "request_already_seen");
  assert.equal(submissionFailureKind(false, { code: "P2002", meta: { target: ["requestId"] } }), "outcome_unknown");
  assert.equal(submissionFailureKind(false, { code: "P2002", meta: { modelName: "AdminAuditLog", target: ["id"] } }), "outcome_unknown");
  assert.equal(submissionFailureKind(false, new Error("before commit")), "definitive_failure");
  assert.equal(submissionFailureKind(true, new Error("Connection reset by peer")), "outcome_unknown");
});
