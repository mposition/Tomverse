import assert from "node:assert/strict";
import { test } from "node:test";

import { amuxNodeEditBinding, amuxNodeEditEvidenceRef, amuxNodeEditReasonFits,
  amuxPortfolioNodeEditPayloadSchema, amuxProjectedTaskScore } from
  "../lib/amux/portfolioNodeEditCore.ts";
import { amuxPortfolioAssessmentPayloadSchema } from
  "../lib/amux/portfolioScoreSchemas.ts";

// Owner decision 2026-11-21: the owner edits an Initiative, Epic or Feature.

const payload = (extra = {}) => ({
  id: "0b6c3f7e-2b1d-4d55-9a51-0a2c3e4f5a61",
  requestId: "1c7d4f8e-3c2e-4e66-8b62-1b3d4f5a6b72",
  nodeId: "33333333-cccc-4ccc-8ccc-000000000003", expectedRevision: 0,
  expectedAssessmentId: "2d8e5f9e-4d3f-4f77-9c73-2c4e5f6a7b83",
  content: { title: "AEO-01 crawl policy", description: "Let AI search bots read\r\npublic pages." },
  value: 4, uncertainty: "medium", reasonCode: "operator_override",
  evidenceAsOf: "2026-11-21T00:00:00.000Z", ...extra });

test("the payload accepts a content edit and normalises the description's line ends", () => {
  const parsed = amuxPortfolioNodeEditPayloadSchema.parse(payload());
  assert.equal(parsed.content.description, "Let AI search bots read\npublic pages.");
  assert.equal(amuxPortfolioNodeEditPayloadSchema.parse(payload({ content: null })).content, null);
});

test("the payload refuses empty or control-character titles, long text and out-of-range values", () => {
  for (const bad of [
    payload({ content: { title: "  ", description: "" } }),
    payload({ content: { title: "a\u0007b", description: "" } }),
    payload({ content: { title: "x".repeat(201), description: "" } }),
    payload({ content: { title: "ok", description: "x".repeat(4_001) } }),
    payload({ value: 6 }), payload({ value: 2.5 }), payload({ expectedRevision: -1 }),
    payload({ nodeId: "../etc" }), payload({ uncertainty: "none" }),
    { ...payload(), extra: true },
  ]) assert.equal(amuxPortfolioNodeEditPayloadSchema.safeParse(bad).success, false);
});

test("the owner's evidence reference passes the existing assessment schema", () => {
  const ref = amuxNodeEditEvidenceRef(payload().nodeId, 1);
  assert.equal(ref, "node:33333333-cccc-4ccc-8ccc-000000000003:r1");
  assert.equal(amuxPortfolioAssessmentPayloadSchema.safeParse({
    id: payload().id, requestId: payload().requestId,
    subject: { kind: "feature", id: payload().nodeId }, metrics: { value: 4 },
    uncertainty: "medium", evidenceRefs: [ref], evidenceAsOf: payload().evidenceAsOf,
    reasonCode: "operator_override", modelProposalDigest: null }).success, true);
});

test("the binding holds digests and the inputs the owner saw, never text", () => {
  const binding = amuxNodeEditBinding({ actorUserId: "owner", level: "feature",
    payload: amuxPortfolioNodeEditPayloadSchema.parse(payload()),
    priorContentDigest: "a".repeat(64), nextContentDigest: "b".repeat(64),
    priorAssessmentId: "assessment-1",
    affectedTasks: [{ taskId: "task-b", scoreId: "score-b", inputs: [
      { subjectId: "epic-1", revision: 0, assessmentId: "assessment-e" },
      { subjectId: "task-b", revision: 2, assessmentId: null }] },
    { taskId: "task-a", scoreId: null, inputs: [] }] });
  assert.deepEqual(binding.affectedTasks.map((task) => task.taskId), ["task-a", "task-b"]);
  assert.equal(binding.priorAssessmentId, "assessment-1");
  assert.equal(binding.affectedTasks[1].scoreId, "score-b");
  // Order on the path is kept: the score reads it top down.
  assert.deepEqual(binding.affectedTasks[1].inputs.map((item) => item.subjectId),
    ["epic-1", "task-b"]);
  assert.equal(JSON.stringify(binding).includes("crawl policy"), false);
  assert.equal(binding.nextContentDigest, "b".repeat(64));
});

test("the estimate moves only this level's weighted value", () => {
  const components = { initiative: 16, epic: 9, feature: 8 };
  assert.equal(amuxProjectedTaskScore({ level: "feature", nextValue: 5,
    currentTotal: 62, currentComponents: components }), 64);
  assert.equal(amuxProjectedTaskScore({ level: "initiative", nextValue: 2,
    currentTotal: 62, currentComponents: components }), 54);
  assert.equal(amuxProjectedTaskScore({ level: "epic", nextValue: 3,
    currentTotal: null, currentComponents: null }), null);
});

test("a first assessment says initial; a later one must not", () => {
  assert.equal(amuxNodeEditReasonFits("initial", false), true);
  assert.equal(amuxNodeEditReasonFits("operator_override", false), false);
  assert.equal(amuxNodeEditReasonFits("initial", true), false);
  assert.equal(amuxNodeEditReasonFits("new_evidence", true), true);
});

test("a Task's approved path stands through the owner's node revisions, nothing else", async () => {
  const { amuxApprovedNodeStillCurrent } = await import("../lib/amux/portfolioNodeEditCore.ts");
  const approved = { revision: 0, content: { digest: "a".repeat(64), keyId: "k1" },
    approvedDecisionId: "decision-1" };
  const rev0 = { contentDigest: "a".repeat(64), contentDigestKeyId: "k1", decisionId: "decision-1" };
  // Unrevised: the node itself must carry the approved content.
  assert.equal(amuxApprovedNodeStillCurrent({ approved, approvedRevision: null,
    node: { revision: 0, contentDigest: "a".repeat(64), contentDigestKeyId: "k1" } }), true);
  assert.equal(amuxApprovedNodeStillCurrent({ approved, approvedRevision: null,
    node: { revision: 0, contentDigest: "b".repeat(64), contentDigestKeyId: "k1" } }), false);
  // Revised by the owner: the approved revision is still on record.
  const revised = { revision: 2, contentDigest: "c".repeat(64), contentDigestKeyId: "k1" };
  assert.equal(amuxApprovedNodeStillCurrent({ approved, node: revised, approvedRevision: rev0 }), true);
  for (const approvedRevision of [null, { ...rev0, contentDigest: "d".repeat(64) },
    { ...rev0, contentDigestKeyId: "k2" }, { ...rev0, decisionId: "decision-2" }]) {
    assert.equal(amuxApprovedNodeStillCurrent({ approved, node: revised, approvedRevision }), false);
  }
  // A node older than the approval never stands.
  assert.equal(amuxApprovedNodeStillCurrent({ approved: { ...approved, revision: 3 },
    node: revised, approvedRevision: rev0 }), false);
});
