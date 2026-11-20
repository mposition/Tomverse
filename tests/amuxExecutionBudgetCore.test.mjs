import assert from "node:assert/strict";
import test from "node:test";

import {
  amuxApprovedCeilingOverrun,
  decideAmuxAttemptBudget,
  settlementDestinationForBudget,
} from "../lib/amux/executionBudgetCore.ts";

// Owner direction 2026-11-15 and 2026-11-18: no fixed count stops an ordinary
// card, and "no bound" is null (tests/amuxRetryTermination.test.mjs has the
// repeat rule and tests/amuxInfraFailureCore.test.mjs the platform failures).
test("new attempts are monotonic and an ordinary card has no bound", () => {
  assert.deepEqual(
    decideAmuxAttemptBudget({
      historical_rows: 2,
      greatest_attempt_number: 2,
    }),
    { allowed: true, next_attempt_number: 3, max_attempts: null },
  );
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 5, greatest_attempt_number: null }).allowed, true);
  assert.deepEqual(
    decideAmuxAttemptBudget({ historical_rows: 30, greatest_attempt_number: null }),
    { allowed: true, next_attempt_number: 31, max_attempts: null },
    "the number thirty that stopped a card until 2026-11-18 stops nothing",
  );
  assert.deepEqual(
    decideAmuxAttemptBudget({ historical_rows: 4, greatest_attempt_number: 900 }),
    { allowed: true, next_attempt_number: 901, max_attempts: null },
  );
});

test("a caller that names a bound is stopped at it, and only that caller", () => {
  assert.deepEqual(
    decideAmuxAttemptBudget({ historical_rows: 3, greatest_attempt_number: null, max_attempts: 3 }),
    { allowed: false, exhausted_limit: "attempts", attempts_used: 3, max_attempts: 3 },
  );
  assert.deepEqual(
    decideAmuxAttemptBudget({ historical_rows: 3, greatest_attempt_number: null, max_attempts: 4 }),
    { allowed: true, next_attempt_number: 4, max_attempts: 4 },
  );
});

test("a failed attempt of an ordinary card goes back to todo however many came before", () => {
  assert.deepEqual(
    settlementDestinationForBudget({ requested_status: "todo", attempt_number: 30 }),
    { to_status: "todo", exhausted_limit: null, max_attempts: null },
  );
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 5 }).to_status, "todo");
  assert.equal(settlementDestinationForBudget({ requested_status: "review", attempt_number: 30 }).to_status, "review");
  // A paid retry's own bound blocks the last failed attempt instead of requeueing it.
  assert.deepEqual(
    settlementDestinationForBudget({ requested_status: "todo", attempt_number: 2, max_attempts: 2 }),
    { to_status: "blocked", exhausted_limit: "attempts", max_attempts: 2 },
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
