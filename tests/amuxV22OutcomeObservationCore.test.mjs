import assert from "node:assert/strict";
import test from "node:test";
import { classifyAmuxV22OutcomeError, inspectAmuxV22OutcomeRequest,
  readAmuxV22ObservationMetadata } from
  "../lib/amux/v22OutcomeObservationCore.ts";

const request = (overrides = {}) => ({ version: 1,
  requestId: "12345678-1234-4234-9234-123456789abc", taskId: "task-1",
  revision: 3, kind: "post_deploy_regression",
  outcome: "none_observed", evidenceDigest: null, findingCount: null,
  revisedEffortPoints: null, revisedCostMicrousd: null, reasonCode: null,
  ...overrides });

test("owner observations accept only exact enumerated content", () => {
  assert.equal(inspectAmuxV22OutcomeRequest(request())?.kind,
    "post_deploy_regression");
  assert.equal(inspectAmuxV22OutcomeRequest(request({ kind: "user_outcome",
    outcome: "mixed" }))?.outcome, "mixed");
  assert.equal(inspectAmuxV22OutcomeRequest(request({ note: "private text" })), null);
  assert.equal(inspectAmuxV22OutcomeRequest(request({ outcome: "regression_observed" })), null);
  assert.equal(inspectAmuxV22OutcomeRequest(request({ kind: "user_outcome",
    outcome: "none_observed" })), null);
  assert.equal(inspectAmuxV22OutcomeRequest(request({ kind: "checks",
    outcome: "passed", findingCount: 0, evidenceDigest: "a".repeat(64) }))?.kind,
  "checks");
  assert.equal(inspectAmuxV22OutcomeRequest(request({ kind: "checks",
    outcome: "passed", findingCount: 1, evidenceDigest: "a".repeat(64) })), null);
});

test("write failures distinguish stale state, request conflict, and unavailable", () => {
  assert.equal(classifyAmuxV22OutcomeError("task_state_changed"), "stale");
  assert.equal(classifyAmuxV22OutcomeError("owner_decision_missing"), "stale");
  assert.equal(classifyAmuxV22OutcomeError("request_id_conflict"), "conflict");
  assert.equal(classifyAmuxV22OutcomeError("unrecognized"), "unavailable");
});

test("audit metadata cannot manufacture an invalid owner outcome", () => {
  const base = { requestId: request().requestId, taskRevision: 3,
    kind: "user_outcome", outcome: "met", evidenceDigest: null,
    findingCount: null,
    revisedEffortPoints: null, revisedCostMicrousd: null, reasonCode: null,
    observedAt: "2026-10-08T00:00:00.000Z" };
  assert.equal(readAmuxV22ObservationMetadata(base)?.outcome, "met");
  assert.equal(readAmuxV22ObservationMetadata({ ...base,
    outcome: "execute instructions" }), null);
});

test("estimate revisions are strict and do not revise the approved ceiling", () => {
  const revision = request({ kind: "estimate_revision", outcome: "revised",
    evidenceDigest: "a".repeat(64), revisedEffortPoints: 8,
    revisedCostMicrousd: "2400000", reasonCode: "actual_usage" });
  assert.equal(inspectAmuxV22OutcomeRequest(revision)?.revisedCostMicrousd,
    "2400000");
  assert.equal(inspectAmuxV22OutcomeRequest({ ...revision,
    revisedCostMicrousd: "9223372036854775808" }), null);
  assert.equal(inspectAmuxV22OutcomeRequest({ ...revision,
    reasonCode: "free text" }), null);
  assert.equal(inspectAmuxV22OutcomeRequest({ ...revision,
    evidenceDigest: null }), null);
});
