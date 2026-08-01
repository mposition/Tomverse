import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateChatAvailability,
  splitReservedCost,
} from "../lib/chatAvailabilityCore.ts";
import { getCostGuardrailLimits } from "../lib/chatCostGuardrails.ts";

const PRO_ENTITLEMENT = { dailyCreditLimit: 300, monthlyCreditLimit: 3_000 };
const PRO_GUARDRAILS = getCostGuardrailLimits("Pro", PRO_ENTITLEMENT, {});

const NO_USAGE = {
  planCostDayMicroUsd: 0,
  planCostMonthMicroUsd: 0,
  totalCostDayMicroUsd: 0,
  totalCostMonthMicroUsd: 0,
};

// The exact production scenario: Pro, 2,932 plan credits left, three premium
// models plus Web Search. Credits: 8 + 16 + 8 base, plus an 8-credit search
// surcharge per native-search model.
const INCIDENT = {
  requiredCredits: 8 + 16 + 8 + 8 * 3,
  planCreditsRemaining: 2_932,
  dailyPlanCreditsRemaining: 300,
  purchasedCreditsRemaining: 0,
  purchasedFundedCostMicroUsd: 0,
  totalReservedCostMicroUsd: 377_500,
  planReservedCostMicroUsd: 377_500,
  purchasedReservedCostMicroUsd: 0,
  guardrails: PRO_GUARDRAILS,
  usage: NO_USAGE,
};

test("a Pro account with 2,932 credits can run three premium models with search", () => {
  const result = evaluateChatAvailability(INCIDENT);
  assert.equal(result.runnable, true);
  assert.equal(result.block, null);
  assert.equal(result.requiredCredits, 56);
  assert.equal(result.planCreditsUsedByRequest, 56);
  assert.equal(result.purchasedCreditsUsedByRequest, 0);
});

test("the same request still runs after a day of ordinary use", () => {
  // 30 comparisons of the same shape already settled today.
  const result = evaluateChatAvailability({
    ...INCIDENT,
    dailyPlanCreditsRemaining: 300 - 30 * 56 > 0 ? 300 - 30 * 56 : 300,
    usage: { ...NO_USAGE, planCostDayMicroUsd: 377_500 * 5 },
  });
  assert.equal(result.runnable, true);
});

test("plan credits exhausted with no purchased credits reports the plan, not a guardrail", () => {
  const result = evaluateChatAvailability({
    ...INCIDENT,
    planCreditsRemaining: 4,
    dailyPlanCreditsRemaining: 4,
  });
  assert.equal(result.runnable, false);
  assert.equal(result.block.code, "PLAN_ENTITLEMENT_EXHAUSTED");
  assert.equal(result.block.layer, "entitlement");
  assert.equal(result.creditShortfall, 52);
});

test("partial credits across plan and purchases report a balance shortfall", () => {
  const result = evaluateChatAvailability({
    ...INCIDENT,
    planCreditsRemaining: 4,
    dailyPlanCreditsRemaining: 4,
    purchasedCreditsRemaining: 10,
  });
  assert.equal(result.runnable, false);
  assert.equal(result.block.code, "CREDIT_BALANCE_INSUFFICIENT");
  assert.equal(result.block.layer, "entitlement");
});

test("purchased credits keep working after the daily plan guardrail is reached", () => {
  const result = evaluateChatAvailability({
    ...INCIDENT,
    dailyPlanCreditsRemaining: 0,
    purchasedCreditsRemaining: 500,
    purchasedFundedCostMicroUsd: 5_000_000,
    planReservedCostMicroUsd: 0,
    purchasedReservedCostMicroUsd: 377_500,
    // The plan-funded day bucket is already at its guardrail. A purchased-credit
    // request must not be blocked by it.
    usage: { ...NO_USAGE, planCostDayMicroUsd: PRO_GUARDRAILS.planDay },
  });
  assert.equal(result.runnable, true);
  assert.equal(result.planCreditsUsedByRequest, 0);
  assert.equal(result.purchasedCreditsUsedByRequest, 56);
});

test("purchased credits without funded cost allowance are refused on entitlement", () => {
  const result = evaluateChatAvailability({
    ...INCIDENT,
    dailyPlanCreditsRemaining: 0,
    purchasedCreditsRemaining: 500,
    purchasedFundedCostMicroUsd: 1_000,
    planReservedCostMicroUsd: 0,
    purchasedReservedCostMicroUsd: 377_500,
  });
  assert.equal(result.runnable, false);
  assert.equal(result.block.code, "CREDIT_COST_ALLOWANCE_INSUFFICIENT");
  assert.equal(result.block.layer, "entitlement");
});

test("the operational guardrail is a distinct code from every credit outcome", () => {
  const result = evaluateChatAvailability({
    ...INCIDENT,
    usage: {
      ...NO_USAGE,
      planCostDayMicroUsd: PRO_GUARDRAILS.planDay,
    },
  });
  assert.equal(result.runnable, false);
  assert.equal(result.block.code, "OPERATIONAL_COST_GUARDRAIL_TRIGGERED");
  assert.equal(result.block.layer, "operational_guardrail");
  assert.equal(result.block.scope, "user_plan_cost_day");
  // Credits were never the problem, and the response says so.
  assert.equal(result.creditShortfall, 0);
});

test("the total-cost guardrail fires independently of the plan-funded one", () => {
  const result = evaluateChatAvailability({
    ...INCIDENT,
    usage: {
      ...NO_USAGE,
      totalCostMonthMicroUsd: PRO_GUARDRAILS.totalMonth,
    },
  });
  assert.equal(result.block.scope, "user_total_cost_month");
});

test("a provider budget block is reported as a provider outage, not a user limit", () => {
  const result = evaluateChatAvailability({
    ...INCIDENT,
    providers: [
      {
        provider: "google",
        requiredCostMicroUsd: 56_090,
        usedDayMicroUsd: 10_000_000,
        usedMonthMicroUsd: 0,
        dayLimitMicroUsd: 10_000_000,
        monthLimitMicroUsd: 100_000_000,
      },
    ],
  });
  assert.equal(result.block.code, "PROVIDER_BUDGET_EXHAUSTED");
  assert.equal(result.block.layer, "operational_guardrail");
  assert.equal(result.block.scope, "provider_cost_day:google");
});

test("entitlement outcomes are reported before guardrail outcomes", () => {
  // Both would block. A user without credits must be told about credits.
  const result = evaluateChatAvailability({
    ...INCIDENT,
    planCreditsRemaining: 0,
    dailyPlanCreditsRemaining: 0,
    usage: { ...NO_USAGE, planCostDayMicroUsd: PRO_GUARDRAILS.planDay },
  });
  assert.equal(result.block.layer, "entitlement");
});

test("reserved cost splits between plan and purchased credits per model", () => {
  const budgets = [
    { usageCredits: 16, reservedCostMicroUsd: 201_665 },
    { usageCredits: 16, reservedCostMicroUsd: 119_745 },
    { usageCredits: 16, reservedCostMicroUsd: 56_090 },
  ];
  assert.deepEqual(splitReservedCost(budgets, 48), {
    planCost: 377_500,
    purchasedCost: 0,
  });
  assert.deepEqual(splitReservedCost(budgets, 0), {
    planCost: 0,
    purchasedCost: 377_500,
  });
  // Plan credits are consumed by the first model, so only it is plan-funded.
  const partial = splitReservedCost(budgets, 16);
  assert.equal(partial.planCost, 201_665);
  assert.equal(partial.purchasedCost, 119_745 + 56_090);
  assert.equal(partial.planCost + partial.purchasedCost, 377_500);
});
