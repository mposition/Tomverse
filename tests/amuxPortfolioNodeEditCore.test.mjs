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

test("the binding holds digests, never text, and sorts the affected Tasks", () => {
  const binding = amuxNodeEditBinding({ actorUserId: "owner", level: "feature",
    payload: amuxPortfolioNodeEditPayloadSchema.parse(payload()),
    priorContentDigest: "a".repeat(64), nextContentDigest: "b".repeat(64),
    affectedTaskIds: ["task-b", "task-a"] });
  assert.deepEqual(binding.affectedTaskIds, ["task-a", "task-b"]);
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
