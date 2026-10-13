import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-10-13T01:00:00.000Z");
let taskRevision = 4; let runtimeReads = 0; let calls = 0; let selected: unknown;
const task = () => ({ id: "task-1", revision: taskRevision, status: "blocked", cardType: "task",
  executionAttempts: [{ id: "attempt-1", taskRevision: 3, worker: "claude-chore", workerInstanceId: "old-instance",
    workerGeneration: 2, outcome: "expired", endedAt: now, heartbeatAt: now, leaseExpiresAt: now,
    reservedCostMicrousd: BigInt(3_400_000), settledCostMicrousd: null, costConfirmed: false,
    delivery: { status: "acknowledged" }, v22TaskResult: null, cliUsageEvents: [] }] });
const boundary = { operation: "execution_recovery_read", prismaCallCeiling: 4, isolation: "read" };
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_DB_BOUNDARIES: { executionRecoveryRead: boundary },
  withAmuxDbBoundary: async (actual: unknown, work: (tx: unknown, context: unknown) => Promise<unknown>) => {
    assert.equal(actual, boundary); calls = 1;
    const result = await work({
      amuxWorkItem: { findUnique: async (query: unknown) => { calls += 1; selected = query; return task(); } },
      amuxWorkerRuntime: { findUnique: async () => { calls += 1; runtimeReads += 1;
        return { instanceId: "new-instance", generation: 3, status: "idle", heartbeatAt: now, leaseExpiresAt: now }; } },
    }, { dbNow: now }); calls += 1;
    assert.ok(calls <= boundary.prismaCallCeiling); return result;
  } } });
const service = import(mod("lib/amux/ownerRecoveryInspectionRead.ts"));
test("reader projects exact attempt metadata through the read boundary without bodies or authority", async () => {
  const { readAmuxOwnerRecoveryInspection } = await service;
  const result = await readAmuxOwnerRecoveryInspection({ taskId: "task-1", taskRevision: 4, attemptId: "attempt-1" });
  assert.equal(result.state, "ready"); assert.equal(calls, 4);
  if (result.state !== "ready") return;
  assert.equal(result.inspection.checkedAt, now.toISOString());
  assert.equal(result.inspection.runtime.state, "different_instance");
  assert.equal(result.inspection.cost.reservedMaximumMicrousd, "3400000");
  assert.equal(result.inspection.cost.settledMicrousd, null);
  assert.equal(result.inspection.usage.inputTokens, null);
  assert.equal(result.inspection.result.state, "not_recorded");
  assert.equal(result.inspection.ubuntuProcessVerified, false);
  assert.equal(result.inspection.recoveryAuthorized, false);
  const selection = JSON.stringify(selected);
  assert.doesNotMatch(selection, /ciphertext|prompt|description|executionBrief/);
  assert.match(selection, /taskRevision.*desc/);
  const previousRuntimeReads = runtimeReads; taskRevision = 5;
  assert.equal((await readAmuxOwnerRecoveryInspection({ taskId: "task-1", taskRevision: 4, attemptId: "attempt-1" })).state, "changed");
  assert.equal(runtimeReads, previousRuntimeReads);
});
