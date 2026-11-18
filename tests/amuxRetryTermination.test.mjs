// Where a v22 card that keeps failing stops (owner decisions 2026-11-15 and
// 2026-11-18: no fixed count and no repeat of the same failure stops a card,
// and a repeat only makes the claim wait longer). A retried card stops only
// when a reviewer marked a blocking finding as repeating an earlier one
// (blocked). Platform failures never stop it either, and a paid retry keeps
// its own bound. The settle path (lib/amux/execution.ts) composes these pure
// decisions; this file drives them the way consecutive settlements do.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_REPEATED_FAILURE_RUNS,
  amuxResultFailureSignature,
  amuxResultFailureStreak,
  amuxResultRetryDelayMs,
  decideAmuxAttemptBudget,
  settlementDestinationForBudget,
} from "../lib/amux/executionBudgetCore.ts";
import { decideAmuxV52ReviewDisposition } from "../lib/amux/v52ReviewCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Settles reviewed runs one after another as execution.ts does: the review
 * decides the status and reason, the reason is the run's failure signature,
 * and the budget decides where the card goes. Returns the run that stopped
 * the card and why, or the longest streak of the same failure when every run
 * went back to todo.
 */
const runReviewed = (verdicts, { repeatsPrior = () => false } = {}) => {
  const signatures = [];
  let rejections = 0;
  let longest = 0;
  for (const [index, verdict] of verdicts.entries()) {
    const disposition = decideAmuxV52ReviewDisposition(verdict, rejections, repeatsPrior(index));
    if (disposition.status !== "todo") return { run: index + 1, status: disposition.status, why: disposition.reason };
    const signature = amuxResultFailureSignature("succeeded", disposition.reason);
    const budget = settlementDestinationForBudget({ requested_status: "todo", attempt_number: index + 1 });
    if (budget.to_status !== "todo") return { run: index + 1, status: budget.to_status, why: budget.exhausted_limit };
    signatures.unshift(signature);
    longest = Math.max(longest, amuxResultFailureStreak(signatures));
    if (verdict === "reject") rejections += 1;
  }
  return { run: null, longest };
};

test("(a) the same result failure repeating never stops the card; it only lengthens the wait", () => {
  assert.deepEqual(runReviewed(["reject", "reject", "reject", "reject"]), { run: null, longest: 4 });
  assert.deepEqual(runReviewed(["unknown", "unknown", "unknown", "unknown", "unknown"]), { run: null, longest: 5 });
  // Nothing waits through the first three; then a minute that doubles up to an hour.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 100].map(amuxResultRetryDelayMs),
    [0, 0, 0, 0, 60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000]);
  assert.equal(AMUX_REPEATED_FAILURE_RUNS, 3);
  assert.equal(amuxResultRetryDelayMs(Number.NaN), 0);
  assert.equal(amuxResultRetryDelayMs(Number.POSITIVE_INFINITY), 0, "an unreadable count never waits");
});

test("(b) a rejection the reviewer marks as repeating an earlier finding stops it at once", () => {
  assert.deepEqual(runReviewed(["reject", "reject"], { repeatsPrior: (index) => index === 1 }),
    { run: 2, status: "blocked", why: "review_server_rejected_twice" });
});

test("(d) results that keep changing never stop at a count either", () => {
  const verdicts = Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? "reject" : "unknown"));
  assert.deepEqual(runReviewed(verdicts), { run: null, longest: 1 });
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 5_000 }).to_status, "todo");
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 5_000, greatest_attempt_number: 5_000 }).allowed, true);
});

test("a caller that names no bound has none: null, never a number or Infinity", () => {
  const open = decideAmuxAttemptBudget({ historical_rows: 3, greatest_attempt_number: 3 });
  assert.deepEqual(open, { allowed: true, next_attempt_number: 4, max_attempts: null });
  assert.equal(JSON.stringify(open), '{"allowed":true,"next_attempt_number":4,"max_attempts":null}');
  for (const max of [Number.POSITIVE_INFINITY, Number.NaN])
    assert.equal(decideAmuxAttemptBudget({ historical_rows: 3, greatest_attempt_number: 3, max_attempts: max })
      .max_attempts, null, String(max));
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 9 }).max_attempts, null);
});

test("(e) a paid retry that names its own bound still stops at it", () => {
  assert.deepEqual(decideAmuxAttemptBudget({ historical_rows: 2, greatest_attempt_number: 2, max_attempts: 2 }),
    { allowed: false, exhausted_limit: "attempts", attempts_used: 2, max_attempts: 2 });
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 1, greatest_attempt_number: 1, max_attempts: 2 }).allowed, true);
  assert.deepEqual(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 2, max_attempts: 2 }),
    { to_status: "blocked", exhausted_limit: "attempts", max_attempts: 2 });
  assert.equal(settlementDestinationForBudget({ requested_status: "todo", attempt_number: 1, max_attempts: 2 })
    .to_status, "todo");
  // The settle and the start of the paid path name a bound; neither may lose it.
  assert.match(read("lib/amux/execution.ts"), /max_attempts: AMUX_V22_READ_ONLY_RETRY_TASK_ATTEMPT_LIMIT,/);
  assert.match(read("lib/amux/v22TaskRecoveryService.ts"),
    /max_attempts: AMUX_V22_PAID_RETRY_ATTEMPT_LIMIT \}\);\n\}/);
  assert.match(read("lib/amux/v22WorkerClaimService.ts"),
    /recovery\?\.riskAcceptanceId && !decideAmuxAttemptBudget\([^)]*max_attempts: AMUX_V22_PAID_RETRY_ATTEMPT_LIMIT/);
});

test("(c) platform failures never stop a card: they only wait, counted from a person's last retry", () => {
  // Any number of platform failures goes back to todo (2026-11-16: twelve handed the card over).
  for (const run of [1, 12, 13, 40, 400]) {
    const budget = settlementDestinationForBudget({ requested_status: "todo", attempt_number: run,
      infra_attempts_before: run - 1, infra_failure: true });
    assert.equal(budget.to_status, "todo", String(run));
  }
  assert.equal(decideAmuxAttemptBudget({ historical_rows: 200, greatest_attempt_number: 200,
    infra_rows: 200 }).allowed, true);
  const store = read("lib/amux/infraFailureStore.ts");
  assert.match(store, /e\."resolvedById" IS NOT NULL AND e\."resolvedById" NOT LIKE 'system:%'/);
  // The wait grows with the failures since the last person's retry; the claim holds it.
  assert.match(read("lib/amux/v22WorkerClaimService.ts"), /amuxInfraRetryDelayMs\(prior\.infraWindowRows\)/);
  assert.match(read("lib/amux/legacyCardSystemService.ts"),
    /AMUX_DM_OWNER_SETTLEMENT_RESOLVER = "system:amux-dm-owner-settlement"/,
    "the settlement resolves as a system resolver");
  // The settlement's retry has no count to check (2026-11-18).
  assert.doesNotMatch(read("lib/amux/dmOwnerSettlementService.ts"), /attempt_budget_spent|readAmuxAttemptBudgetFacts/);
});

test("the claim waits out a repeated result failure and never parks the card", () => {
  const claim = read("lib/amux/v22WorkerClaimService.ts");
  assert.match(claim, /amuxResultRetryDelayMs\(streak\)/);
  assert.match(claim, /throw new AmuxClaimSkipError\("result_retry_backoff", \{ attemptsUsed: streak \}\)/);
  // Skipped like the platform backoff: one waiting card never holds the rest.
  assert.match(claim, /const SKIPPED_CODES = new Set\(\[[^\]]*"result_retry_backoff"/);
  const store = read("lib/amux/infraFailureStore.ts");
  assert.match(store, /a\."reason" <> ALL\(\$\{infra\}::text\[\]\)/, "platform failures are not part of the streak");
  assert.match(store, /r\."at" IS NULL OR a\."startedAt" > r\."at"/, "a person's retry starts it over");
});

test("the settle path no longer hands a repeated failure over, and stores the review's reason", () => {
  const execution = read("lib/amux/execution.ts");
  assert.doesNotMatch(execution, /repeated_failure|amuxRepeatedResultFailure|readAmuxRecentResultSignatures/);
  assert.match(execution, /reviewDisposition \? reviewDisposition\.status :/);
  assert.match(execution, /exhaustedReason \?\? reviewDisposition\?\.reason \?\?/,
    "the stored attempt reason is the same reason, so the claim reads the same signature");
});
