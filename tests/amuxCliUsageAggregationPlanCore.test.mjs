import assert from "node:assert/strict";
import test from "node:test";

import { planAmuxCliProviderYearAggregates } from
  "../lib/amux/cliUsageAggregationPlanCore.ts";

let serial = 0;
const row = (month, overrides = {}) => {
  serial += 1;
  return {
    invocationId: `123e4567-e89b-42d3-a456-${String(serial).padStart(12, "0")}`,
    recordedAt: `2026-${month}-15T12:00:00.000Z`,
    actualProviderId: "openai",
    actualModelId: "gpt-6-sol",
    workerRole: "implement",
    inputTokens: BigInt(10),
    outputTokens: BigInt(5),
    cacheReadInputTokens: BigInt(2),
    cacheCreationInputTokens: null,
    ...overrides,
  };
};
const many = (month, count, overrides = {}) =>
  Array.from({ length: count }, () => row(month, overrides));
const plan = (rows, overrides = {}) => planAmuxCliProviderYearAggregates({
  year: 2026, actualProviderId: "openai",
  serverNow: "2027-01-20T00:00:00.000Z", rows, ...overrides,
});

test("a provider-year under five is excluded, never published as zero", () => {
  const result = plan(many("01", 4));
  assert.deepEqual(result, { outcome: "excluded_small", cells: [] });
  assert.deepEqual(plan([]), { outcome: "empty", cells: [] });
});

test("one small role folds every role sibling for the same month and model", () => {
  const rows = [
    ...many("01", 4, { workerRole: "design" }),
    ...many("01", 5, { workerRole: "review" }),
    ...many("01", 5, { actualModelId: "gpt-6-astra" }),
  ];
  const result = plan(rows);
  assert.equal(result.outcome, "planned");
  assert.deepEqual(result.cells.map((cell) => [
    cell.granularity, cell.actualModelId, cell.workerRole, cell.invocationCount,
  ]), [
    ["month_model", "gpt-6-sol", null, 9],
    ["month_role", "gpt-6-astra", "implement", 5],
  ]);
  assert.equal(result.cells.reduce((sum, cell) => sum + cell.invocationCount, 0), rows.length);
});

test("one small model folds all model siblings for the month", () => {
  const result = plan([
    ...many("02", 4, { actualModelId: "gpt-6-sol" }),
    ...many("02", 5, { actualModelId: "gpt-6-astra" }),
  ]);
  assert.deepEqual(result.cells.map((cell) => [
    cell.granularity, cell.period, cell.actualModelId, cell.invocationCount,
  ]), [["month", "2026-02", null, 9]]);
});

test("one small month folds every month in its quarter", () => {
  const result = plan([
    ...many("01", 5), ...many("02", 2), ...many("03", 5),
  ]);
  assert.deepEqual(result.cells.map((cell) => [
    cell.granularity, cell.period, cell.invocationCount,
  ]), [["quarter", "2026-Q1", 12]]);
});

test("one small quarter folds all provider-year siblings", () => {
  const result = plan([
    ...many("01", 5), ...many("04", 2), ...many("07", 5),
  ]);
  assert.deepEqual(result.cells.map((cell) => [
    cell.granularity, cell.period, cell.invocationCount,
  ]), [["year", "2026", 12]]);
});

test("partial token observations retain unknown counts separately from observed sums", () => {
  const result = plan([
    ...many("06", 3),
    ...many("06", 2, { inputTokens: null, outputTokens: null }),
  ]);
  assert.equal(result.outcome, "planned");
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].tokenSums.inputTokens, null);
  assert.equal(result.cells[0].tokenSums.outputTokens, null);
  assert.equal(result.cells[0].unknownTokenCounts.inputTokens, 2);
  assert.equal(result.cells[0].unknownTokenCounts.outputTokens, 2);
  assert.equal(result.cells[0].tokenSums.cacheReadInputTokens, BigInt(10));
  assert.equal(result.cells[0].unknownTokenCounts.cacheCreationInputTokens, 5);
});

test("one observed token value inside a five-call cell is never published", () => {
  const result = plan([
    ...many("06", 1, { inputTokens: BigInt(12345) }),
    ...many("06", 4, { inputTokens: null }),
  ]);
  assert.equal(result.cells[0].invocationCount, 5);
  assert.equal(result.cells[0].unknownTokenCounts.inputTokens, 4);
  assert.equal(result.cells[0].tokenSums.inputTokens, null);
  assert.equal(result.cells[0].tokenSums.outputTokens, BigInt(25));
});

test("unknown actual provider is isolated from named providers", () => {
  const rows = many("07", 5, { actualProviderId: null, actualModelId: null });
  const result = plan(rows, { actualProviderId: null });
  assert.equal(result.cells[0].actualProviderId, null);
  assert.equal(result.cells[0].actualModelId, null);
  assert.throws(() => plan(rows), /source row is invalid/);
});

test("open years and missed 13-month deletion deadlines fail closed", () => {
  const rows = many("01", 5);
  assert.throws(() => plan(rows, { serverNow: "2026-12-31T23:59:59.999Z" }),
    /still open/);
  assert.throws(() => plan(rows, { serverNow: "2027-01-01T00:00:00.000Z" }),
    /still open/);
  assert.equal(plan(rows, { serverNow: "2027-01-02T00:00:00.000Z" }).outcome,
    "planned");
  // These January 15 rows have not expired on February 5, but January 1
  // rows could already be gone. Never silently treat the remainder as a year.
  assert.throws(() => plan(rows, { serverNow: "2027-02-05T12:00:00.000Z" }),
    /provider-year deletion deadline/);
  assert.throws(() => plan([], { serverNow: "2027-02-05T12:00:00.000Z" }),
    /provider-year deletion deadline/);
});

test("duplicate or malformed source rows fail rather than inflating k", () => {
  const rows = many("08", 5);
  assert.throws(() => plan([...rows, rows[0]]), /source row is invalid/);
  assert.throws(() => plan(rows.map((item, index) => index === 0 ?
    { ...item, inputTokens: BigInt(-1) } : item)), /source row is invalid/);
  assert.throws(() => plan(rows.map((item, index) => index === 0 ?
    { ...item, recordedAt: "2025-08-15T12:00:00.000Z" } : item)),
  /outside its provider year/);
});
