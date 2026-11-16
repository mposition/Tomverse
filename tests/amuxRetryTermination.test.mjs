// Where a v22 card that keeps failing stops, with #4004, #4005 and #4006
// merged (owner decisions 2026-11-15: no fixed count stops a card, and nothing
// runs forever with no person seeing it). A retried card stops when
//   (a) its own result failed the same way three runs in a row (repeated_failure),
//   (b) a reviewer marked a blocking finding as repeating an earlier one (blocked),
//   (c) it failed on the platform twelve times since a person last sent it back,
//   (d) it used the runaway guard's thirty counted attempts.
// The settle path (lib/amux/execution.ts) composes these pure decisions; this
// file drives them the way consecutive settlements do.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_MAX_EXECUTION_ATTEMPTS,
  AMUX_REPEATED_FAILURE_RUNS,
  amuxRepeatedResultFailure,
  amuxResultFailureSignature,
  decideAmuxAttemptBudget,
  settlementDestinationForBudget,
} from "../lib/amux/executionBudgetCore.ts";
import { decideAmuxV52ReviewDisposition } from "../lib/amux/v52ReviewCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Settles reviewed runs one after another as execution.ts does: the review
 * decides the status and reason, the reason is the run's failure signature,
 * and the budget decides where the card goes. Returns the run that stopped
 * the card and why, or null when every run went back to todo.
 */
const runReviewed = (verdicts, { repeatsPrior = () => false } = {}) => {
  const signatures = [];
  let rejections = 0;
  for (const [index, verdict] of verdicts.entries()) {
    const disposition = decideAmuxV52ReviewDisposition(verdict, rejections, true, repeatsPrior(index));
    if (disposition.status !== "todo") return { run: index + 1, status: disposition.status, why: disposition.reason };
    const signature = amuxResultFailureSignature("succeeded", disposition.reason);
    const repeated = amuxRepeatedResultFailure([signature, ...signatures.slice(0, AMUX_REPEATED_FAILURE_RUNS - 1)]);
    const budget = settlementDestinationForBudget({ requested_status: "todo", attempt_number: index + 1,
      repeated_failure: repeated });
    if (budget.to_status !== "todo") return { run: index + 1, status: budget.to_status, why: budget.exhausted_limit };
    signatures.unshift(signature);
    if (verdict === "reject") rejections += 1;
  }
  return null;
};

test("(a) three rejections in a row stop the card as the same result failure, whatever they found", () => {
  assert.deepEqual(runReviewed(["reject", "reject", "reject", "reject"]),
    { run: 3, status: "blocked", why: "repeated_failure" });
});

test("(a) three unknown reviews in a row stop it too: an unknown is asked again, not forever", () => {
  assert.deepEqual(runReviewed(["unknown", "unknown", "unknown", "unknown"]),
    { run: 3, status: "blocked", why: "repeated_failure" });
});

test("(b) a rejection the reviewer marks as repeating an earlier finding stops it at once", () => {
  assert.deepEqual(runReviewed(["reject", "reject"], { repeatsPrior: (index) => index === 1 }),
    { run: 2, status: "blocked", why: "review_server_rejected_twice" });
});

test("(d) results that keep changing stop at the runaway guard, never later", () => {
  const verdicts = Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? "reject" : "unknown"));
  assert.deepEqual(runReviewed(verdicts), { run: AMUX_MAX_EXECUTION_ATTEMPTS, status: "blocked", why: "attempts" });
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
  const settlement = read("lib/amux/dmOwnerSettlementService.ts");
  assert.match(settlement, /readAmuxAttemptBudgetFacts\(tx, row\.taskId\)/);
  assert.match(settlement, /return handOff\("attempt_budget_spent"\)/);
});

test("the settle path uses these decisions: the review's reason is the run's failure signature", () => {
  const execution = read("lib/amux/execution.ts");
  assert.match(execution, /amuxResultFailureSignature\(input\.outcome, reviewDisposition\?\.reason \?\?/);
  assert.match(execution, /reviewDisposition \? reviewDisposition\.status :/);
  assert.match(execution, /exhaustedReason \?\? reviewDisposition\?\.reason \?\?/,
    "the stored attempt reason is the same reason, so the next settle reads the same signature");
});
