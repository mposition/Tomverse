import assert from "node:assert/strict";
import test from "node:test";

import { estimateAmuxCliApiCost, makeAmuxCliUsageReceipt,
  amuxCliUsageReceiptSchema } from "../lib/amux/cliUsageLedgerCore.ts";

const base = {
  invocationId: "run-1", binding: { kind: "task_attempt", attemptId: "attempt-1" },
  worker: "worker-a", selectedModelId: "claude-opus-5",
  cliVersion: "2.0.1", authentication: "subscription",
  startedAt: "2026-10-06T00:00:00.000Z", endedAt: "2026-10-06T00:00:02.000Z",
  status: "succeeded",
};
const observation = {
  version: 1, cli: "claude", completeness: "reported_complete",
  observed: { inputTokens: 100, outputTokens: 50,
    cacheReadInputTokens: 20, cacheCreationInputTokens: 10,
    reasoningOutputTokens: null }, completedTurns: 1,
  inputTokensIncludeCacheRead: false, inputTokensIncludeCacheWrite: false,
  reasoningOutputIncludedInOutput: null,
  models: [{ modelId: "claude-opus-5", observed: { inputTokens: 100,
    outputTokens: 50, cacheReadInputTokens: 20,
    cacheCreationInputTokens: 10, reasoningOutputTokens: null } }],
};
const price = { provider: "anthropic", modelId: "claude-opus-5",
  version: "approved-v1", uncachedInputMicroUsdPerMillion: 4_000_000,
  cacheReadMicroUsdPerMillion: 400_000,
  cacheWriteMicroUsdPerMillion: 8_000_000,
  outputMicroUsdPerMillion: 20_000_000,
  reasoningOutputMicroUsdPerMillion: null };

test("Claude categories are disjoint and produce only an API conversion estimate", () => {
  const receipt = makeAmuxCliUsageReceipt({ ...base, observation });
  assert.equal(receipt.actualModelId, "claude-opus-5");
  assert.equal(estimateAmuxCliApiCost(receipt, price), BigInt(1488));
  assert.equal(receipt.observed.inputTokens, 100);
  assert.equal(receipt.authentication, "subscription");
});

test("Codex inclusive cache is subtracted and unknown cache write blocks pricing", () => {
  const receipt = makeAmuxCliUsageReceipt({ ...base, observation: {
    ...observation, cli: "codex", inputTokensIncludeCacheRead: true,
    inputTokensIncludeCacheWrite: null,
    reasoningOutputIncludedInOutput: true, observed: {
      ...observation.observed, inputTokens: 100, cacheReadInputTokens: 20,
      cacheCreationInputTokens: null, reasoningOutputTokens: 5 },
    models: [] }, selectedModelId: "gpt-6-astra" });
  assert.equal(receipt.actualModelId, null);
  assert.equal(estimateAmuxCliApiCost(receipt, null), null);
});

test("multi-model and unreported usage are not estimated as zero", () => {
  const multi = makeAmuxCliUsageReceipt({ ...base, observation: {
    ...observation, models: [observation.models[0], { ...observation.models[0],
      modelId: "claude-sonnet-5" }] } });
  assert.equal(multi.actualModelId, "multi_model");
  assert.equal(estimateAmuxCliApiCost(multi, price), null);
  const unknown = makeAmuxCliUsageReceipt({ ...base, status: "interrupted",
    observation: { ...observation, observed: null, completeness: "unknown",
      models: [], completedTurns: 0 } });
  assert.equal(unknown.observed, null);
  assert.equal(estimateAmuxCliApiCost(unknown, price), null);
});

test("receipt refuses prompt/body fields and inconsistent numeric evidence", () => {
  const receipt = makeAmuxCliUsageReceipt({ ...base, observation });
  assert.equal(amuxCliUsageReceiptSchema.safeParse({ ...receipt,
    prompt: "secret" }).success, false);
  assert.equal(amuxCliUsageReceiptSchema.safeParse({ ...receipt,
    observed: null }).success, false);
  assert.equal(amuxCliUsageReceiptSchema.safeParse({ ...receipt,
    endedAt: "2026-10-05T00:00:00.000Z" }).success, false);
});
