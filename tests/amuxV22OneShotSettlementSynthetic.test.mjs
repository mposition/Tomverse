import assert from "node:assert/strict";
import test from "node:test";

import { amuxCliUsageReceiptDigest } from
  "../lib/amux/cliUsageLedgerCore.ts";
import { executeAmuxCliWithUsageReceipt } from
  "../lib/amux/cliUsageExecutionWrapper.mjs";
import { v22ExecutionReceiptVerified } from
  "../lib/amux/v22TaskExecutionCore.ts";

const observation = { version: 1, cli: "claude",
  completeness: "reported_complete", completedTurns: 1,
  observed: { inputTokens: 100, outputTokens: 20,
    cacheReadInputTokens: 8, cacheCreationInputTokens: 2,
    reasoningOutputTokens: null },
  inputTokensIncludeCacheRead: false,
  inputTokensIncludeCacheWrite: false,
  reasoningOutputIncludedInOutput: null,
  models: [{ modelId: "claude-opus-5", observed: {
    inputTokens: 100, outputTokens: 20,
    cacheReadInputTokens: 8, cacheCreationInputTokens: 2,
    reasoningOutputTokens: null } }],
};

const run = async ({ resultKind = "verified_success", writeReply = "saved",
  readBack = "recorded", throws = false } = {}) => {
  let count = 0;
  let receipt;
  const wrapped = await executeAmuxCliWithUsageReceipt({
    invocationId: "attempt-1",
    binding: { kind: "task_attempt", attemptId: "attempt-1" },
    worker: "worker-1", selectedModelId: "claude-opus-5",
    invoke: async () => { count += 1;
      if (throws) throw new Error("synthetic child timeout");
      return { kind: resultKind, cliStarted: true, cliVersion: "2.1.288",
        authentication: "subscription", usageObservation: observation }; },
    record: async (value) => { receipt = value;
      return writeReply === "saved" ? { invocationId: value.invocationId,
        receiptDigest: amuxCliUsageReceiptDigest(value) } : null; },
    readBack: async () => readBack === "recorded" ? {
      status: "recorded", receiptDigest: amuxCliUsageReceiptDigest(receipt),
    } : { status: "absent" },
  });
  return { wrapped, receipt, count };
};

test("one verified invocation can settle review or a known Task failure", async () => {
  const { wrapped, receipt, count } = await run();
  assert.equal(wrapped.kind, "recorded");
  assert.equal(count, 1);
  const evidence = { attemptId: "attempt-1", invocationIds: ["attempt-1"],
    events: [{ invocationId: receipt.invocationId,
      status: receipt.status, completeness: receipt.completeness,
      projectedApiCostMicrousd: 200n, source: receipt.source,
      actualModelId: receipt.actualModelId,
      selectedModelId: receipt.selectedModelId }],
    reservedCostMicrousd: 250n, resultStored: true };
  assert.equal(v22ExecutionReceiptVerified({ ...evidence,
    outcome: "succeeded" }), true);
  assert.equal(v22ExecutionReceiptVerified({ ...evidence,
    outcome: "failed" }), true);
});

test("lost receipt reply reads back once; missing proof and timeout never settle", async () => {
  const recovered = await run({ writeReply: "lost" });
  assert.equal(recovered.wrapped.kind, "recorded");
  assert.equal(recovered.count, 1);
  const unknown = await run({ writeReply: "lost", readBack: "absent" });
  assert.equal(unknown.wrapped.kind, "outcome_unknown");
  assert.equal(unknown.count, 1);
  const timeout = await run({ throws: true });
  assert.equal(timeout.wrapped.kind, "outcome_unknown");
  assert.equal(timeout.receipt, undefined);
  assert.equal(timeout.count, 1);
});

test("a failed or expensive receipt cannot claim a successful Task", async () => {
  const failed = await run({ resultKind: "invocation_failed" });
  assert.equal(failed.receipt.status, "failed");
  const evidence = { attemptId: "attempt-1", invocationIds: ["attempt-1"],
    events: [{ invocationId: "attempt-1", status: failed.receipt.status,
      completeness: failed.receipt.completeness,
      projectedApiCostMicrousd: 200n, source: failed.receipt.source,
      actualModelId: failed.receipt.actualModelId,
      selectedModelId: failed.receipt.selectedModelId }],
    reservedCostMicrousd: 250n, resultStored: true };
  assert.equal(v22ExecutionReceiptVerified({ ...evidence,
    outcome: "succeeded" }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...evidence,
    outcome: "failed" }), true);
  assert.equal(v22ExecutionReceiptVerified({ ...evidence,
    outcome: "failed", events: [{ ...evidence.events[0],
      projectedApiCostMicrousd: 251n }] }), false);
  assert.equal(v22ExecutionReceiptVerified({ ...evidence,
    outcome: "failed", events: [...evidence.events, evidence.events[0]] }), false);
});
