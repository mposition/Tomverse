import assert from "node:assert/strict";
import test from "node:test";
import { amuxFeedbackTaskWhere, projectAmuxTaskFeedback, readAmuxV4ApprovedCeiling,
  rollupAmuxTaskFeedback } from
  "../lib/amux/v22TaskFeedbackCore.ts";

const start = new Date("2026-10-01T00:00:00.000Z");
const end = new Date("2026-10-01T00:03:00.000Z");
const decidedAt = new Date("2026-10-01T00:05:00.000Z");
const task = (overrides = {}) => ({
  id: "task-1", revision: 4, status: "done", createdAt: start,
  effortPoints: 3, estimatedCostMicrousd: 500000n,
  attempts: [{ id: "attempt-1", startedAt: start, endedAt: end,
    outcome: "succeeded", settledCostMicrousd: 200000n, costConfirmed: true }],
  usage: [{ attemptId: "attempt-1", completeness: "reported_complete",
    inputTokens: 100n, outputTokens: 20n, cacheReadInputTokens: 10n,
    cacheCreationInputTokens: 5n, projectedApiCostMicrousd: 120000n,
    actualApiCostMicrousd: null }],
  decisions: [{ id: "decision-1", outcome: "approve", decidedAt }],
  ...overrides,
});

test("feedback separates confirmed spend, projected API cost, and unknown actual API cost", () => {
  const feedback = projectAmuxTaskFeedback(task());
  assert.equal(feedback.observed.executionMs, 180000);
  assert.equal(feedback.observed.cycleMs, 300000);
  assert.equal(feedback.observed.settledCostMicrousd, "200000");
  assert.equal(feedback.observed.projectedApiCostMicrousd, "120000");
  assert.equal(feedback.observed.actualApiCostMicrousd, null);
  assert.equal(feedback.observed.usage.inputTokens, "100");
  assert.equal(feedback.observed.postDeployRegression, null);
  assert.equal(feedback.observed.userOutcome, null);
});

test("partial usage and unfinished attempts remain unknown rather than zero", () => {
  const incomplete = projectAmuxTaskFeedback(task({ status: "review",
    attempts: [{ ...task().attempts[0], endedAt: null }],
    usage: [{ ...task().usage[0], completeness: "reported_partial" }],
    decisions: [] }));
  assert.equal(incomplete.observed.executionMs, null);
  assert.equal(incomplete.observed.cycleMs, null);
  assert.equal(incomplete.observed.usage, null);
  assert.equal(incomplete.observed.projectedApiCostMicrousd, null);
  assert.equal(incomplete.evidence.completeUsage, false);
});

test("an attempt without a usage receipt cannot make a partial total look complete", () => {
  const feedback = projectAmuxTaskFeedback(task({ attempts: [
    task().attempts[0], { ...task().attempts[0], id: "attempt-2" },
  ] }));
  assert.equal(feedback.observed.attemptCount, 2);
  assert.equal(feedback.observed.usage, null);
  assert.equal(feedback.observed.projectedApiCostMicrousd, null);
  assert.equal(feedback.evidence.completeUsage, false);
});

test("a task without attempts has unknown duration and spend", () => {
  const feedback = projectAmuxTaskFeedback(task({ attempts: [], usage: [] }));
  assert.equal(feedback.observed.attemptCount, 0);
  assert.equal(feedback.observed.executionMs, null);
  assert.equal(feedback.observed.settledCostMicrousd, null);
  assert.equal(feedback.evidence.completeExecution, false);
});

test("owner retry still has a measured decision interval", () => {
  const feedback = projectAmuxTaskFeedback(task({ status: "todo",
    decisions: [{ id: "decision-retry", outcome: "retry", decidedAt }] }));
  assert.equal(feedback.observed.cycleMs, 300000);
  assert.equal(rollupAmuxTaskFeedback([feedback]).cycleMs, 300000);
});

test("rollup does not turn missing child evidence into a smaller total", () => {
  const complete = projectAmuxTaskFeedback(task());
  const unknown = projectAmuxTaskFeedback(task({ id: "task-2",
    estimatedCostMicrousd: null,
    attempts: [{ ...task().attempts[0], id: "attempt-2",
      costConfirmed: false, settledCostMicrousd: null }], usage: [] }));
  const rollup = rollupAmuxTaskFeedback([complete, unknown]);
  assert.equal(rollup.taskCount, 2);
  assert.equal(rollup.doneCount, 2);
  assert.equal(rollup.estimatedCostMicrousd, null);
  assert.equal(rollup.settledCostMicrousd, null);
  assert.equal(rollup.incompleteUsageCount, 1);
  assert.equal(rollup.subjectiveOutcomeMissingCount, 2);
});

test("the approved v4 maximum comes from the unit receipt, not the legacy estimate", () => {
  assert.equal(readAmuxV4ApprovedCeiling({ card: { task: { costReceipt: {
    ceilingMicroUsd: "500000" } } } }), 500000n);
  assert.equal(readAmuxV4ApprovedCeiling({ card: { task: { costReceipt: {
    ceilingMicroUsd: "-1" } } } }), null);
  assert.equal(projectAmuxTaskFeedback(task({ estimatedCostMicrousd: null,
    approvedCeilingMicrousd: 500000n })).expected.approvedCeilingMicrousd,
  "500000");
});

test("check and independent review findings stay separate from owner outcomes", () => {
  const feedback = projectAmuxTaskFeedback(task({ observations: [
    { kind: "checks", outcome: "failed", findingCount: 2,
      evidenceDigest: "a".repeat(64), observedAt: end.toISOString(),
      taskRevision: 4 },
    { kind: "independent_review", outcome: "passed", findingCount: 0,
      evidenceDigest: "b".repeat(64), observedAt: decidedAt.toISOString(),
      taskRevision: 4 },
  ] }));
  assert.equal(feedback.observed.checks.findingCount, 2);
  assert.equal(feedback.observed.independentReview.findingCount, 0);
  assert.equal(feedback.observed.userOutcome, null);
  assert.equal(rollupAmuxTaskFeedback([feedback]).checkFindings, 2);
});

test("latest revised forecast remains separate from immutable approved ceiling", () => {
  const feedback = projectAmuxTaskFeedback(task({
    approvedCeilingMicrousd: 500000n,
    observations: [{ kind: "estimate_revision", outcome: "revised",
      evidenceDigest: "a".repeat(64), findingCount: null,
      revisedEffortPoints: 5, revisedCostMicrousd: "600000",
      reasonCode: "scope_changed", observedAt: end.toISOString(),
      taskRevision: 4 }],
  }));
  assert.equal(feedback.expected.approvedCeilingMicrousd, "500000");
  assert.equal(feedback.observed.estimateRevision.revisedCostMicrousd, "600000");
});

test("an earlier attempt's observation is not reported as current", () => {
  const feedback = projectAmuxTaskFeedback(task({ observations: [
    { kind: "user_outcome", outcome: "met", evidenceDigest: null,
      findingCount: null, revisedEffortPoints: null,
      revisedCostMicrousd: null, reasonCode: null,
      observedAt: end.toISOString(), taskRevision: 3 },
  ] }));
  assert.equal(feedback.observed.userOutcome, null);
});

test("Story and node feedback queries exclude archived Tasks", () => {
  assert.deepEqual(amuxFeedbackTaskWhere({ kind: "story", id: "story-1" }, []),
    { cardType: "task", parentStoryCardId: "story-1", archivedAt: null });
  assert.deepEqual(amuxFeedbackTaskWhere({ kind: "node", id: "node-1" },
    ["feature-1"]), { cardType: "task",
    parentFeatureNodeId: { in: ["feature-1"] }, archivedAt: null });
});
