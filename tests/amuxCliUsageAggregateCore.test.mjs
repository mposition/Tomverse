import assert from "node:assert/strict";
import test from "node:test";

import { rollupAmuxCliUsageFacts } from
  "../lib/amux/cliUsageAggregateCore.ts";

const fact = (overrides = {}) => ({
  month: "2025-01", provider: "anthropic", model: "claude-opus-5",
  role: "develop", calls: 5, reportedCalls: 5,
  inputTokens: 500n, outputTokens: 50n,
  cacheReadInputTokens: 25n, cacheCreationInputTokens: 10n,
  projectedApiCostMicrousd: 7n, projectedCalls: 5,
  ...overrides,
});

test("complete role/model/month cohorts keep the finest non-overlapping cells", () => {
  const cells = rollupAmuxCliUsageFacts([
    fact(), fact({ role: "review", calls: 6 }),
  ]);
  assert.equal(cells.length, 2);
  assert.ok(cells.every((cell) => cell.grain === "month_role_model"));
  assert.equal(cells.reduce((sum, cell) => sum + cell.calls, 0), 11);
});

test("small role and model cells collapse globally without exposing a sibling", () => {
  const cells = rollupAmuxCliUsageFacts([
    fact({ calls: 4 }), fact({ role: "review", calls: 1 }),
    fact({ model: "claude-sonnet-5", calls: 2 }),
  ]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].grain, "month_provider");
  assert.equal(cells[0].calls, 7);
  assert.equal(cells[0].model, null);
  assert.equal(cells[0].role, null);
});

test("sparse months merge by quarter then year; under-five years disappear", () => {
  const quarter = rollupAmuxCliUsageFacts([
    fact({ calls: 2 }), fact({ month: "2025-02", calls: 3 }),
  ]);
  assert.equal(quarter.length, 1);
  assert.equal(quarter[0].grain, "quarter_provider");
  const year = rollupAmuxCliUsageFacts([
    fact({ calls: 2 }), fact({ month: "2025-08", calls: 3 }),
  ]);
  assert.equal(year.length, 1);
  assert.equal(year[0].grain, "year_provider");
  assert.deepEqual(rollupAmuxCliUsageFacts([fact({ calls: 4 })]), []);
});
