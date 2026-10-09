import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { amuxPortfolioAssessmentPayloadSchema,
  amuxPortfolioScorePayloadSchema, parseAmuxPortfolioMetrics } from
  "../lib/amux/portfolioScoreSchemas.ts";

const payload = () => ({ id: randomUUID(), requestId: randomUUID(),
  subject: { kind: "task", id: "task_card_0001" },
  metrics: { contribution: 4, urgency: 3, dependencyUnlock: 2,
    workerCoverage: 1, effort: 2, deliveryRisk: 1 },
  uncertainty: "medium", evidenceRefs: ["source_0001"],
  evidenceAsOf: new Date().toISOString(), reasonCode: "initial",
  modelProposalDigest: null });

test("portfolio evidence accepts only bounded typed metrics and opaque refs", () => {
  const valid = payload();
  assert.equal(amuxPortfolioAssessmentPayloadSchema.safeParse(valid).success, true);
  assert.deepEqual(parseAmuxPortfolioMetrics("task", valid.metrics), valid.metrics);
  assert.throws(() => parseAmuxPortfolioMetrics("task", {
    ...valid.metrics, contribution: 6 }));
  assert.throws(() => parseAmuxPortfolioMetrics("task", {
    ...valid.metrics, hiddenPriority: 5 }));
  assert.equal(amuxPortfolioAssessmentPayloadSchema.safeParse({
    ...valid, evidenceRefs: ["/private/source.txt"] }).success, false);
  assert.equal(amuxPortfolioAssessmentPayloadSchema.safeParse({
    ...valid, modelProposalDigest: "not-a-digest" }).success, false);
});

test("score payload contains no status, SEV1 or worker command", () => {
  const valid = { id: randomUUID(), requestId: randomUUID(),
    taskId: "task_card_0001" };
  assert.equal(amuxPortfolioScorePayloadSchema.safeParse(valid).success, true);
  assert.equal(amuxPortfolioScorePayloadSchema.safeParse({
    ...valid, status: "todo" }).success, false);
  assert.equal(amuxPortfolioScorePayloadSchema.safeParse({
    ...valid, sev1: true }).success, false);
});
