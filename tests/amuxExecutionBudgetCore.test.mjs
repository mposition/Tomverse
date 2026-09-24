import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_MAX_EXECUTION_ATTEMPTS,
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
