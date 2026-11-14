import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_MAX_EXECUTION_ATTEMPTS,
  amuxApprovedCeilingOverrun,
  decideAmuxAttemptBudget,
  settlementDestinationForBudget,
} from "../lib/amux/executionBudgetCore.ts";

test("new attempts are monotonic and stop at the bounded retry limit", () => {
  assert.deepEqual(
    decideAmuxAttemptBudget({
      historical_rows: 2,
      greatest_attempt_number: 2,
    }),
    {
      allowed: true,
      next_attempt_number: 3,
      max_attempts: AMUX_MAX_EXECUTION_ATTEMPTS,
    },
  );
  assert.deepEqual(
    decideAmuxAttemptBudget({
      historical_rows: 5,
      greatest_attempt_number: null,
    }),
    {
      allowed: false,
      exhausted_limit: "attempts",
      attempts_used: 5,
      max_attempts: AMUX_MAX_EXECUTION_ATTEMPTS,
    },
  );
});

test("the last failed attempt blocks instead of requeueing forever", () => {
  assert.deepEqual(
    settlementDestinationForBudget({
      requested_status: "todo",
      attempt_number: 5,
    }),
    {
      to_status: "blocked",
      exhausted_limit: "attempts",
      max_attempts: 5,
    },
  );
  assert.equal(
    settlementDestinationForBudget({
      requested_status: "todo",
      attempt_number: 4,
    }).to_status,
    "todo",
  );
  assert.equal(
    settlementDestinationForBudget({
      requested_status: "review",
      attempt_number: 5,
    }).to_status,
    "review",
  );
});

// Owner decision 2026-11-14: the receipt ceiling (per-attempt maximum times its
// maxAttempts, 2-3) is below what the five-attempt budget can reserve. Going
// past it is recorded, never refused.
test("an attempt past the approved ceiling is reported, one within it is not", () => {
  const receipt = { ceilingMicroUsd: "6800000" };
  assert.equal(amuxApprovedCeilingOverrun({ approvedReceipt: receipt,
    priorReservedMicroUsd: 0n, nextAttemptMicroUsd: 3_400_000n }), null);
  assert.equal(amuxApprovedCeilingOverrun({ approvedReceipt: receipt,
    priorReservedMicroUsd: 3_400_000n, nextAttemptMicroUsd: 3_400_000n }), null,
    "reaching the ceiling exactly is within it");
  assert.deepEqual(amuxApprovedCeilingOverrun({ approvedReceipt: receipt,
    priorReservedMicroUsd: 6_800_000n, nextAttemptMicroUsd: 3_400_000n }), {
    ceilingMicroUsd: "6800000", priorReservedMicroUsd: "6800000",
    projectedMicroUsd: "10200000" });
});

test("an unreadable receipt ceiling reports nothing", () => {
  for (const approvedReceipt of [null, undefined, "6800000", [], {},
    { ceilingMicroUsd: 6_800_000 }, { ceilingMicroUsd: "-1" },
    { ceilingMicroUsd: "1e6" }]) {
    assert.equal(amuxApprovedCeilingOverrun({ approvedReceipt,
      priorReservedMicroUsd: 50_000_000n, nextAttemptMicroUsd: 1n }), null);
  }
});
