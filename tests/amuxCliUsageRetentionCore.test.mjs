import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_CLI_USAGE_EVENT_RETENTION_MONTHS,
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
