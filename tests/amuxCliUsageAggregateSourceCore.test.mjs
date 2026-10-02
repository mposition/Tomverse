import assert from "node:assert/strict";
import test from "node:test";

import { projectAmuxCliAggregationSource } from
  "../lib/amux/cliUsageAggregateSourceCore.ts";
import { planAmuxCliProviderYearAggregates } from
  "../lib/amux/cliUsageAggregationPlanCore.ts";

let serial = 0;
const counts = () => ({
  inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2,
  cacheCreationInputTokens: 1, reasoningOutputTokens: null,
});
const receipt = (overrides = {}) => {
  serial += 1;
  return {
    invocationId: `123e4567-e89b-42d3-a456-${String(serial).padStart(12, "0")}`,
    recordedAt: new Date("2026-01-15T00:00:00.000Z"),
    contextKind: "worker", workerRole: "review",
    cli: "claude", completeness: "reported_complete",
    modelsJson: [{ modelId: "claude-opus-5-5", observed: counts() }],
    inputTokens: BigInt(10), outputTokens: BigInt(5),
    cacheReadInputTokens: BigInt(2), cacheCreationInputTokens: BigInt(1),
    ...overrides,
  };
};

test("a verified model and server role project into one unknown-provider source", () => {
  const source = projectAmuxCliAggregationSource(receipt());
  assert.equal(source.actualProviderId, null);
  assert.equal(source.actualModelId, "claude-opus-5-5");
  assert.equal(source.workerRole, "review");
  assert.equal(source.recordedAt, "2026-01-15T00:00:00.000Z");
});

test("multi-model receipts contribute one source to one private aggregate cell", () => {
  const rows = Array.from({ length: 5 }, () => projectAmuxCliAggregationSource(
    receipt({ modelsJson: [
      { modelId: "claude-opus-5-5", observed: counts() },
      { modelId: "claude-fable-5-1", observed: counts() },
    ], inputTokens: BigInt(20), outputTokens: BigInt(10),
    cacheReadInputTokens: BigInt(4), cacheCreationInputTokens: BigInt(2) }),
  ));
  const result = planAmuxCliProviderYearAggregates({
    year: 2026, actualProviderId: null,
    serverNow: "2027-01-20T00:00:00.000Z", rows,
  });
  assert.equal(result.outcome, "planned");
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].actualModelId, "multi_model");
  assert.equal(result.cells[0].invocationCount, 5);
  assert.equal(result.cells[0].tokenSums.inputTokens, BigInt(100));
});

test("a Codex selected model is never used as actual-model evidence", () => {
  assert.equal(projectAmuxCliAggregationSource(receipt({
    cli: "codex", modelsJson: [], selectedModelId: "gpt-6-astra",
  })).actualModelId, "actualModelUnknown");
  assert.throws(() => projectAmuxCliAggregationSource(receipt({
    cli: "codex", selectedModelId: "gpt-6-astra",
  })), /evidence conflicts/);
});

test("partial Claude model evidence and unknown nullable totals stay unknown", () => {
  assert.equal(projectAmuxCliAggregationSource(receipt({
    completeness: "reported_partial",
  })).actualModelId, "actualModelUnknown");
  const unknown = projectAmuxCliAggregationSource(receipt({
    completeness: "unknown", modelsJson: [], inputTokens: null,
    outputTokens: null, cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
  }));
  assert.equal(unknown.actualModelId, "actualModelUnknown");
  assert.equal(unknown.inputTokens, null);
});

test("idea calls have their own role and arbitrary worker-reported roles fail", () => {
  assert.equal(projectAmuxCliAggregationSource(receipt({
    contextKind: "idea_analysis", workerRole: "idea_analysis",
  })).workerRole, "idea_analysis");
  for (const value of [
    receipt({ contextKind: "worker", workerRole: "idea_analysis" }),
    receipt({ contextKind: "idea_analysis", workerRole: "review" }),
    receipt({ workerRole: "admin" }),
    receipt({ recordedAt: new Date("invalid") }),
    receipt({ inputTokens: BigInt(-1) }),
    receipt({ cli: "gemini" }),
    receipt({ completeness: "complete" }),
    receipt({ invocationId: "not-a-uuid" }),
  ]) assert.throws(() => projectAmuxCliAggregationSource(value), /not a valid receipt/);
});

test("model attribution rejects a receipt whose model sums differ", () => {
  assert.throws(() => projectAmuxCliAggregationSource(receipt({
    inputTokens: BigInt(11),
  })), /model totals do not match receipt/);
  assert.throws(() => projectAmuxCliAggregationSource(receipt({
    outputTokens: null,
  })), /model totals do not match receipt/);
});

test("the adapter does not leak a private model or invocation in an error", () => {
  const row = receipt({ inputTokens: BigInt(11) });
  assert.throws(() => projectAmuxCliAggregationSource(row), (error) => {
    assert.ok(!error.message.includes(row.invocationId));
    assert.ok(!error.message.includes("claude-opus-5-5"));
    return true;
  });
});

test("the planner rejects a projected receipt outside the requested year", () => {
  assert.throws(() => planAmuxCliProviderYearAggregates({
    year: 2027, actualProviderId: null,
    serverNow: "2028-01-03T00:00:00.000Z",
    rows: [projectAmuxCliAggregationSource(receipt())],
  }), /outside its provider year/);
});

test("four projected receipts do not become a long-term aggregate", () => {
  const rows = Array.from({ length: 4 }, () =>
    projectAmuxCliAggregationSource(receipt()));
  const result = planAmuxCliProviderYearAggregates({
    year: 2026, actualProviderId: null,
    serverNow: "2027-01-20T00:00:00.000Z", rows,
  });
  assert.equal(result.outcome, "excluded_small");
  assert.deepEqual(result.cells, []);
});
