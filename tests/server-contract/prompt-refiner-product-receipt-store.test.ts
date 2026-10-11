import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const events: string[] = [];
const guardInputs: unknown[] = [];

mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeSystemAuditLog: async () => { events.push("audit"); return "audit-id"; },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
mock.module(mod("lib/promptRefinerProductOperationalGuard.ts"), { namedExports: {
  evaluatePromptRefinerProductAutoGuardInTransaction: async (
    _tx: unknown, current: unknown,
  ) => {
    events.push("guard");
    guardInputs.push(current);
    return { active: true, generation: 1, reasonCode: null };
  },
} });

const storePromise = import(mod("lib/promptRefinerProductReceiptStore.ts"));

test("execution receipt, context and audit precede the same-transaction guard", async () => {
  events.length = 0;
  guardInputs.length = 0;
  const store = await storePromise;
  const tx = { $executeRaw: async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("PromptRefinerProductExecutionReceipt")) {
      events.push("receipt");
    } else if (sql.includes("PromptRefinerProductExecutionContext")) {
      events.push("context");
    }
    return 1;
  } };
  await store.writePromptRefinerProductExecutionReceipt(tx as never, {
    receiptVersion: "prompt-refiner-execution-v1",
    receiptId: "receipt-1",
    requestId: "request-1",
    suggestionId: "suggestion-1",
    refinerVersion: "suggest-v2",
    provider: "openai",
    modelId: "gpt-5.6-luna",
    adapterVersion: "prompt-refiner-product-v1",
    outcome: "suggested",
    failureLayer: "none",
    failureCode: null,
    requestedAt: "2026-10-10T00:00:00.000Z",
    dispatchedAt: "2026-10-10T00:00:00.000Z",
    completedAt: "2026-10-10T00:00:00.000Z",
    preparationLatencyMs: 0,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
    actualCostMicroUsd: 1,
    retryCount: 0,
  }, "auto");
  assert.deepEqual(events, ["receipt", "context", "audit", "guard"]);
  assert.deepEqual(guardInputs, [{ executionReceiptId: "receipt-1" }]);
});

test("disposition audit precedes a guard bound to that exact receipt", async () => {
  events.length = 0;
  guardInputs.length = 0;
  const store = await storePromise;
  const tx = { $executeRaw: async () => { events.push("disposition"); return 1; } };
  await store.writePromptRefinerProductDispositionReceipt(tx as never, {
    receiptVersion: "prompt-refiner-disposition-v1",
    dispositionId: "disposition-1",
    executionReceiptId: "receipt-1",
    requestId: "request-1",
    suggestionId: "suggestion-1",
    outcome: "accepted",
    staleReason: null,
    observedAt: "2026-10-10T00:00:00.000Z",
  });
  assert.deepEqual(events, ["disposition", "audit", "guard"]);
  assert.deepEqual(guardInputs, [{ dispositionReceiptId: "disposition-1" }]);
});
