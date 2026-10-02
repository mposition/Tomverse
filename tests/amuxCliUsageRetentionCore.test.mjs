import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_CLI_USAGE_AGGREGATE_MIN_INVOCATIONS,
  AMUX_CLI_USAGE_AGGREGATE_RETENTION_MONTHS,
  AMUX_CLI_USAGE_EVENT_RETENTION_MONTHS,
  amuxCliAggregateMeetsMinimum,
  amuxCliAggregateRetentionDeadline,
  amuxCliMergedAggregateFirstRecordedAt,
  amuxCliUsageRetentionDeadline,
} from "../lib/amux/cliUsageRetentionCore.ts";

test("AMUX CLI usage event retention is thirteen UTC calendar months", () => {
  assert.equal(AMUX_CLI_USAGE_EVENT_RETENTION_MONTHS, 13);
  assert.equal(
    amuxCliUsageRetentionDeadline("2026-10-02T03:04:05.006Z"),
    "2027-11-02T03:04:05.006Z",
  );
  assert.equal(
    amuxCliUsageRetentionDeadline("2025-12-15T00:00:00.000Z"),
    "2027-01-15T00:00:00.000Z",
  );
});

test("UTC end-of-month clamping does not spill into the following month", () => {
  assert.equal(
    amuxCliUsageRetentionDeadline("2025-01-31T23:59:59.999Z"),
    "2026-02-28T23:59:59.999Z",
  );
  assert.equal(
    amuxCliUsageRetentionDeadline("2023-01-31T00:00:00.000Z"),
    "2024-02-29T00:00:00.000Z",
  );
  assert.equal(
    amuxCliUsageRetentionDeadline("2024-02-29T00:00:00.000Z"),
    "2025-03-29T00:00:00.000Z",
  );
});

test("noncanonical, offset, and impossible timestamps fail closed", () => {
  for (const value of [
    "2026-10-02T03:04:05Z",
    "2026-10-02T13:04:05.006+10:00",
    "2026-02-30T03:04:05.006Z",
    "2026-13-02T03:04:05.006Z",
    "2026-10-02T25:04:05.006Z",
    "2026-10-02T24:00:00.000Z",
    "2026-10-02T23:59:60.000Z",
    "not-a-date",
    null,
    5,
  ]) {
    assert.throws(() => amuxCliUsageRetentionDeadline(value));
  }
});

test("retention deadline cannot exceed the canonical four-digit year range", () => {
  assert.equal(
    amuxCliUsageRetentionDeadline("9998-11-30T00:00:00.000Z"),
    "9999-12-30T00:00:00.000Z",
  );
  assert.throws(() => amuxCliUsageRetentionDeadline("9999-12-31T00:00:00.000Z"));
});

test("v24 aggregate retention is 36 UTC calendar months from its first record", () => {
  assert.equal(AMUX_CLI_USAGE_AGGREGATE_RETENTION_MONTHS, 36);
  assert.equal(
    amuxCliAggregateRetentionDeadline("2027-11-02T03:04:05.006Z"),
    "2030-11-02T03:04:05.006Z",
  );
  assert.equal(
    amuxCliAggregateRetentionDeadline("2024-02-29T23:59:59.999Z"),
    "2027-02-28T23:59:59.999Z",
  );
  assert.throws(() => amuxCliAggregateRetentionDeadline("2027-11-02T13:04:05.006+10:00"));
  assert.throws(() => amuxCliAggregateRetentionDeadline("9999-12-31T00:00:00.000Z"));
});

test("a merged aggregate inherits its earliest original clock", () => {
  const first = amuxCliMergedAggregateFirstRecordedAt([
    "2028-01-01T00:00:00.000Z",
    "2027-11-02T03:04:05.006Z",
    "2027-12-01T00:00:00.000Z",
  ]);
  assert.equal(first, "2027-11-02T03:04:05.006Z");
  assert.equal(amuxCliAggregateRetentionDeadline(first), "2030-11-02T03:04:05.006Z");
  assert.throws(() => amuxCliMergedAggregateFirstRecordedAt([]));
  assert.throws(() => amuxCliMergedAggregateFirstRecordedAt([
    "2028-01-01T00:00:00.000Z", "2028-01-01T10:00:00+10:00",
  ]));
});

test("long-term cells need five distinct invocations, never five tokens", () => {
  assert.equal(AMUX_CLI_USAGE_AGGREGATE_MIN_INVOCATIONS, 5);
  const ids = Array.from({ length: 5 }, (_, index) =>
    `123e4567-e89b-42d3-a456-42661417400${index}`);
  assert.equal(amuxCliAggregateMeetsMinimum([]), false);
  assert.equal(amuxCliAggregateMeetsMinimum(ids.slice(0, 4)), false);
  assert.equal(amuxCliAggregateMeetsMinimum(ids), true);
  assert.equal(amuxCliAggregateMeetsMinimum([...ids.slice(0, 4), ids[0]]), false);
  assert.throws(() => amuxCliAggregateMeetsMinimum([ids[0], "not-an-id"]));
  assert.throws(() => amuxCliAggregateMeetsMinimum(5));
});
