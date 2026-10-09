import assert from "node:assert/strict";
import test from "node:test";

import { amuxCliUsageReceiptDigest, v22ReceiptModelMatchesAssignment } from
  "../lib/amux/cliUsageLedgerCore.ts";
import { executeAmuxCliWithUsageReceipt } from
  "../lib/amux/cliUsageExecutionWrapper.mjs";

const observation = {
  version: 1, cli: "claude", completeness: "reported_complete",
  observed: { inputTokens: 100, outputTokens: 20,
    cacheReadInputTokens: 8, cacheCreationInputTokens: 2,
    reasoningOutputTokens: null },
  completedTurns: 1, inputTokensIncludeCacheRead: false,
  inputTokensIncludeCacheWrite: false,
  reasoningOutputIncludedInOutput: null,
  models: [{ modelId: "claude-opus-5", observed: {
    inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 8,
    cacheCreationInputTokens: 2, reasoningOutputTokens: null,
  } }],
};

const base = { binding: { kind: "task_attempt", attemptId: "attempt-1" },
  worker: "worker-1", selectedModelId: "claude-opus-5",
  invoke: async () => ({ kind: "verified_success", cliStarted: true,
    cliVersion: "2.1.288", authentication: "subscription", usageObservation: observation }),
};

test("common wrapper records a content-free receipt before releasing output", async () => {
  let receipt;
  const result = await executeAmuxCliWithUsageReceipt({ ...base,
    record: async (value) => {
      receipt = value;
      return { invocationId: value.invocationId,
        receiptDigest: amuxCliUsageReceiptDigest(value) };
    },
    readBack: async () => { throw new Error("unexpected readback"); },
  });
  assert.equal(result.kind, "recorded");
  assert.equal(receipt.binding.attemptId, "attempt-1");
  assert.equal(receipt.actualModelId, "claude-opus-5");
  assert.equal(receipt.observed.inputTokens, 100);
  assert.equal(v22ReceiptModelMatchesAssignment(receipt), true);
  assert.equal(v22ReceiptModelMatchesAssignment({ ...receipt,
    actualModelId: null }), true);
  assert.equal(v22ReceiptModelMatchesAssignment({ ...receipt,
    actualModelId: "claude-opus-other" }), false);
  assert.equal(JSON.stringify(receipt).includes("prompt"), false);
});

test("lost write reply uses one exact readback, never reinvokes the CLI", async () => {
  let invocations = 0;
  let posts = 0;
  let receipt;
  const result = await executeAmuxCliWithUsageReceipt({ ...base,
    invoke: async () => { invocations += 1; return base.invoke(); },
    record: async (value) => { posts += 1; receipt = value; return null; },
    readBack: async (invocationId) => ({ status: "recorded",
      receiptDigest: invocationId === receipt.invocationId
        ? amuxCliUsageReceiptDigest(receipt) : "wrong" }),
  });
  assert.equal(result.kind, "recorded");
  assert.equal(invocations, 1);
  assert.equal(posts, 1);
});

test("unknown receipt halts result use; no CLI means no fabricated zero", async () => {
  const unknown = await executeAmuxCliWithUsageReceipt({ ...base,
    record: async () => null,
    readBack: async () => ({ status: "absent" }),
  });
  assert.deepEqual(unknown, { kind: "outcome_unknown" });
  const absent = await executeAmuxCliWithUsageReceipt({ ...base,
    invoke: async () => ({ kind: "refused", cliStarted: false }),
    record: async () => { throw new Error("should not record"); },
    readBack: async () => { throw new Error("should not read back"); },
  });
  assert.equal(absent.kind, "not_started");
});

test("v22 one-shot caller binds its CLI receipt to the attempt ID", async () => {
  let receipt;
  const result = await executeAmuxCliWithUsageReceipt({ ...base,
    invocationId: "attempt-1",
    record: async (value) => { receipt = value;
      return { invocationId: value.invocationId,
        receiptDigest: amuxCliUsageReceiptDigest(value) }; },
    readBack: async () => { throw new Error("unexpected readback"); },
  });
  assert.equal(result.kind, "recorded");
  assert.equal(receipt.invocationId, "attempt-1");
  await assert.rejects(() => executeAmuxCliWithUsageReceipt({ ...base,
    invocationId: "other",
    record: async () => { throw new Error("should not write"); },
    readBack: async () => { throw new Error("should not read"); },
  }), /task invocation must equal attempt ID/);
});
