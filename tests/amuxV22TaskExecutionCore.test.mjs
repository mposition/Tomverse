import assert from "node:assert/strict";
import test from "node:test";

import { amuxV22TaskExecutionEnabled,
  v22ExecutionCostWithinAssignment } from
  "../lib/amux/v22TaskExecutionCore.ts";

test("v22 execution stays dark even with an enabled environment value", () => {
  assert.equal(amuxV22TaskExecutionEnabled("enabled"), false);
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
