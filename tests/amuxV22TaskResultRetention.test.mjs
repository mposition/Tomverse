import assert from "node:assert/strict";
import test from "node:test";

import { v22TaskResultDueAt } from
  "../lib/amux/v22TaskResultRetention.ts";

const createdAt = new Date("2026-10-01T00:00:00.000Z");
const terminalAt = new Date("2026-10-02T00:00:00.000Z");
const base = { createdAt, status: "review", terminalAt: null,
  archivedAt: null, updatedAt: terminalAt };

test("task result is retained while active and for 90 days after terminal state", () => {
  assert.equal(v22TaskResultDueAt(base), null);
  assert.equal(v22TaskResultDueAt({ ...base, status: "done",
    terminalAt })?.toISOString(), "2026-12-31T00:00:00.000Z");
  assert.equal(v22TaskResultDueAt({ ...base, status: "cancelled" })?.toISOString(),
    "2026-12-31T00:00:00.000Z");
  assert.equal(v22TaskResultDueAt({ ...base,
    archivedAt: terminalAt })?.toISOString(),
    "2026-12-31T00:00:00.000Z");
  assert.equal(v22TaskResultDueAt({ ...base,
    archivedAt: new Date("2026-09-01T00:00:00.000Z") })?.toISOString(),
    "2026-12-30T00:00:00.000Z");
});
