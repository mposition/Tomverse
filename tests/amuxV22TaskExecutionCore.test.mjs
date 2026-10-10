import assert from "node:assert/strict";
import test from "node:test";

import { amuxV22EngineeringPublicationEnabled,
  amuxV22TaskExecutionEnabled,
  v22ExecutionCostWithinAssignment,
  v22ExecutionReceiptVerified,
  v22SettlementPatchMatches } from
  "../lib/amux/v22TaskExecutionCore.ts";

test("v22 execution needs its own switch and never opens publication", () => {
  assert.equal(amuxV22TaskExecutionEnabled("enabled"), true);
  for (const flag of [undefined, "", "disabled", "true", "1", " enabled", "ENABLED"]) {
    assert.equal(amuxV22TaskExecutionEnabled(flag), false);
    assert.equal(amuxV22EngineeringPublicationEnabled(flag), false);
  }
  assert.equal(amuxV22EngineeringPublicationEnabled("enabled"), false);
});

test("settlement refuses a patch inserted, removed, or changed after decrypt", () => {
  const readPatch = { taskId: "task-1", sha256: "a".repeat(64),
    baseSha: "b".repeat(40) };
  const storedPatch = { taskId: "task-1", patchSha256: readPatch.sha256,
    baseSha: readPatch.baseSha, bodyPurgedAt: null };
  const matches = (read, stored) => v22SettlementPatchMatches({
    taskId: "task-1", readPatch: read, storedPatch: stored,
  });
  assert.equal(matches(null, null), true);
  assert.equal(matches(readPatch, storedPatch), true);
  assert.equal(matches(null, storedPatch), false);
  assert.equal(matches(readPatch, null), false);
  assert.equal(matches(readPatch, { ...storedPatch,
    patchSha256: "c".repeat(64) }), false);
  assert.equal(matches(readPatch, { ...storedPatch,
    bodyPurgedAt: new Date() }), false);
  assert.equal(matches({ ...readPatch, taskId: "task-2" }, storedPatch), false);
});

test("each attempt fits the assigned route and cumulative owner ceiling", () => {
  const base = { assignedMicroUsd: 1_000n,
    currentMicroUsd: 800n, approvedCeilingMicroUsd: 5_000n,
    priorReservedMicroUsd: 4_000n };
  assert.equal(v22ExecutionCostWithinAssignment(base), true);
  assert.equal(v22ExecutionCostWithinAssignment({ ...base,
    currentMicroUsd: 1_001n }), false);
  assert.equal(v22ExecutionCostWithinAssignment({ ...base,
    priorReservedMicroUsd: 4_001n }), false);
  assert.equal(v22ExecutionCostWithinAssignment({ ...base,
    assignedMicroUsd: 0n }), false);
});

test("v22 settlement accepts only its one preallocated invocation receipt", () => {
  const base = { attemptId: "attempt-1", invocationIds: ["attempt-1"],
    outcome: "succeeded", resultStored: true, reservedCostMicrousd: 1_000n,
    events: [{ invocationId: "attempt-1", status: "succeeded",
      completeness: "reported_complete", projectedApiCostMicrousd: 700n,
      source: "claude_result", actualModelId: "claude-opus-5-5",
      selectedModelId: "claude-opus-5-5" }],
  };
  assert.equal(v22ExecutionReceiptVerified(base), true);
  assert.equal(v22ExecutionReceiptVerified({ ...base, resultStored: false }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base, outcome: "failed",
    events: [{ ...base.events[0], status: "failed" }] }), true);
  assert.equal(v22ExecutionReceiptVerified({ ...base, outcome: "succeeded",
    events: [{ ...base.events[0], status: "failed" }] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base,
    invocationIds: ["other"] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base,
    invocationIds: ["attempt-1", "other"] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base,
    events: [{ ...base.events[0], invocationId: "other" }] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base,
    events: [...base.events, base.events[0]] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base,
    events: [{ ...base.events[0], completeness: "unknown" }] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base,
    events: [{ ...base.events[0], source: "codex_jsonl" }] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base,
    events: [{ ...base.events[0], actualModelId: null }] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base,
    events: [{ ...base.events[0], actualModelId: "claude-sonnet-5" }] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...base,
    events: [{ ...base.events[0], projectedApiCostMicrousd: 1_001n }] }), false);
});
