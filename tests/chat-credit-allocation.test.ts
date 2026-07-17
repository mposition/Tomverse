import assert from "node:assert/strict";
import { test } from "node:test";
import { getChatCreditAllocation } from "@/lib/chatCreditAllocation";

test("uses purchased credits after the daily plan guardrail is reached", () => {
  const allocation = getChatCreditAllocation({
    requiredCredits: 12,
    monthlyPlanCreditsRemaining: 1_840,
    dailyPlanCreditsRemaining: 0,
    purchasedCreditsRemaining: 20,
  });

  assert.equal(allocation.dailyPlanGuardrailBlocked, false);
  assert.equal(allocation.balanceInsufficient, false);
  assert.equal(allocation.planReservedCredits, 0);
  assert.equal(allocation.addOnCreditsRequired, 12);
});

test("reports a daily plan guardrail when monthly credits remain but add-ons do not", () => {
  const allocation = getChatCreditAllocation({
    requiredCredits: 4,
    monthlyPlanCreditsRemaining: 1_840,
    dailyPlanCreditsRemaining: 0,
    purchasedCreditsRemaining: 0,
  });

  assert.equal(allocation.dailyPlanGuardrailBlocked, true);
  assert.equal(allocation.balanceInsufficient, false);
});

test("uses purchased credits after monthly plan credits are exhausted", () => {
  const allocation = getChatCreditAllocation({
    requiredCredits: 8,
    monthlyPlanCreditsRemaining: 0,
    dailyPlanCreditsRemaining: 200,
    purchasedCreditsRemaining: 10,
  });

  assert.equal(allocation.balanceInsufficient, false);
  assert.equal(allocation.planReservedCredits, 0);
  assert.equal(allocation.addOnCreditsRequired, 8);
});

test("distinguishes an insufficient account balance from the daily guardrail", () => {
  const allocation = getChatCreditAllocation({
    requiredCredits: 12,
    monthlyPlanCreditsRemaining: 3,
    dailyPlanCreditsRemaining: 3,
    purchasedCreditsRemaining: 4,
  });

  assert.equal(allocation.balanceInsufficient, true);
  assert.equal(allocation.dailyPlanGuardrailBlocked, false);
  assert.equal(allocation.totalAccountCredits, 7);
});

test("an unlimited daily plan uses monthly plan credits first", () => {
  const allocation = getChatCreditAllocation({
    requiredCredits: 8,
    monthlyPlanCreditsRemaining: 100,
    dailyPlanCreditsRemaining: null,
    purchasedCreditsRemaining: 20,
  });

  assert.equal(allocation.planReservedCredits, 8);
  assert.equal(allocation.addOnCreditsRequired, 0);
});
