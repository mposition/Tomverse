import assert from "node:assert/strict";
import test from "node:test";
import { bindAmuxRecoveryInspection, summarizeAmuxRecoveryUsage } from
  "../lib/amux/ownerRecoveryInspectionCore.ts";

export const inspectionFixture = () => ({ schemaVersion: 1,
  checkedAt: "2026-10-13T01:00:00.000Z",
  task: { id: "task-1", revision: 4, status: "blocked" },
  attempt: { id: "attempt-1", taskRevision: 3, worker: "claude-chore", outcome: "expired",
    endedAt: "2026-10-13T00:00:00.000Z", heartbeatAt: "2026-10-12T23:55:00.000Z", leaseExpiresAt: null },
  result: { state: "not_recorded", sha256: null, bodyVerified: false },
  usage: summarizeAmuxRecoveryUsage([]),
  cost: { reservedMaximumMicrousd: "3400000", confirmed: false, settledMicrousd: null },
  deliveryStatus: "acknowledged", runtime: { state: "same_instance", status: "idle",
    heartbeatAt: "2026-10-13T01:00:00.000Z", leaseExpiresAt: "2026-10-13T01:02:00.000Z" },
  ubuntuProcessVerified: false, recoveryAuthorized: false });
const identity = { taskId: "task-1", taskRevision: 4, attemptId: "attempt-1" };

test("missing and partial usage never become zero usage or a complete sum", () => {
  assert.equal(summarizeAmuxRecoveryUsage([]).inputTokens, null);
  assert.equal(summarizeAmuxRecoveryUsage([]).state, "not_recorded");
  for (const row of [
    { completeness: "unknown", inputTokens: "0", outputTokens: "0" },
    { completeness: "reported_complete", inputTokens: null, outputTokens: "0" },
    { completeness: "reported_complete", inputTokens: "-1", outputTokens: "0" },
  ]) {
    const summary = summarizeAmuxRecoveryUsage([row]);
    assert.equal(summary.state, "incomplete"); assert.equal(summary.inputTokens, null);
  }
});
test("complete stored receipts retain zero and large integer counts without floating point", () => {
  const summary = summarizeAmuxRecoveryUsage([
    { completeness: "reported_complete", inputTokens: "9007199254740993", outputTokens: "0" },
    { completeness: "reported_complete", inputTokens: "2", outputTokens: "3" },
  ]);
  assert.equal(summary.inputTokens, "9007199254740995");
  assert.equal(summary.outputTokens, "3"); assert.equal(summary.state, "reported_complete");
});
test("display limit withholds complete totals instead of silently summing a page", () => {
  const summary = summarizeAmuxRecoveryUsage(Array.from({ length: 101 }, () => ({
    completeness: "reported_complete", inputTokens: "1", outputTokens: "2" })));
  assert.equal(summary.displayedCount, 100); assert.equal(summary.truncated, true);
  assert.equal(summary.state, "incomplete"); assert.equal(summary.outputTokens, null);
});
test("inspection responses bind exact task revision and attempt, never grant host or recovery authority", () => {
  const fixture = inspectionFixture(); assert.equal(bindAmuxRecoveryInspection(fixture, identity), fixture);
  for (const changed of [ { ...fixture, task: { ...fixture.task, revision: 5 } },
    { ...fixture, attempt: { ...fixture.attempt, id: "attempt-new" } },
    { ...fixture, task: { ...fixture.task, id: "other-task" } },
    { ...fixture, recoveryAuthorized: true }, { ...fixture, ubuntuProcessVerified: true },
    { ...fixture, cost: { ...fixture.cost, settledMicrousd: "0" } },
  ]) assert.equal(bindAmuxRecoveryInspection(changed, identity), null);
});
