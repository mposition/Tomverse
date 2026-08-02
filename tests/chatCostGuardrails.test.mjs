import assert from "node:assert/strict";
import test from "node:test";
import {
  COST_PER_CREDIT_CEILING_MICRO_USD,
  findRetiredCostLimitEnvNames,
  getCostGuardrailLimits,
  getGuestCostGuardrailLimits,
  GUARDRAIL_HEADROOM_MULTIPLIER,
  PURCHASED_CREDIT_HEADROOM_MULTIPLE,
  RETIRED_COST_LIMIT_ENV_NAMES,
} from "../lib/chatCostGuardrails.ts";

// The plan from the production report: Pro, 300 plan credits per account-local
// day, 3,000 per month.
const PRO = { dailyCreditLimit: 300, monthlyCreditLimit: 3_000 };
const FREE = { dailyCreditLimit: 30, monthlyCreditLimit: 300 };
const MAX = { dailyCreditLimit: 0, monthlyCreditLimit: 10_000 };

test("the Pro guardrail is far above the retired US$1.50/day ceiling", () => {
  const limits = getCostGuardrailLimits("Pro", PRO, {});
  // Old defaults, kept here as the regression this change exists to prevent.
  assert.ok(limits.planDay > 1_500_000);
  assert.ok(limits.planMonth > 4_500_000);
  assert.equal(
    limits.planDay,
    Math.ceil(
      300 * COST_PER_CREDIT_CEILING_MICRO_USD * GUARDRAIL_HEADROOM_MULTIPLIER
    )
  );
  assert.equal(
    limits.planMonth,
    Math.ceil(
      3_000 * COST_PER_CREDIT_CEILING_MICRO_USD * GUARDRAIL_HEADROOM_MULTIPLIER
    )
  );
});

test("the reproduction request fits inside the Pro guardrail with room to spare", () => {
  const limits = getCostGuardrailLimits("Pro", PRO, {});
  // Three premium models at their real prices, reserving p90 output:
  //   GPT-5.5 Thinking  3,469*5  + 6,144*30 = 201,665
  //   Claude Opus 4.8   3,469*5  + 4,096*25 = 119,745
  //   Gemini 3.1 Pro    3,469*2  + 4,096*12 =  56,090
  const reservedCostMicroUsd = 201_665 + 119_745 + 56_090;
  assert.equal(reservedCostMicroUsd, 377_500);

  // The same request was refused with US$0.13 of allowance remaining. Under the
  // derived guardrail it fits many times over in a single day.
  assert.ok(limits.planDay / reservedCostMicroUsd > 30);
});

test("a plan with no daily credit limit gets no separate daily cost guardrail", () => {
  const limits = getCostGuardrailLimits("Max", MAX, {});
  assert.equal(limits.planDay, limits.planMonth);
  assert.equal(limits.totalDay, limits.totalMonth);
});

test("guardrails scale with the plan's own credit grant", () => {
  const free = getCostGuardrailLimits("Free", FREE, {});
  const pro = getCostGuardrailLimits("Pro", PRO, {});
  const max = getCostGuardrailLimits("Max", MAX, {});
  assert.ok(free.planMonth < pro.planMonth);
  assert.ok(pro.planMonth < max.planMonth);
});

test("purchased credits get their own headroom above the plan guardrail", () => {
  const limits = getCostGuardrailLimits("Pro", PRO, {});
  assert.equal(
    limits.totalMonth,
    limits.derived.planMonth * PURCHASED_CREDIT_HEADROOM_MULTIPLE
  );
  assert.ok(limits.totalDay > limits.planDay);
});

test("an environment override below the derived floor is clamped, not honoured", () => {
  const limits = getCostGuardrailLimits("Pro", PRO, {
    CHAT_COST_GUARDRAIL_PRO_PLAN_MICROUSD_PER_DAY: "1500000",
  });
  assert.equal(limits.planDay, limits.derived.planDay);
  assert.deepEqual(limits.clampedOverrides, [
    "CHAT_COST_GUARDRAIL_PRO_PLAN_MICROUSD_PER_DAY",
  ]);
});

test("an environment override above the derived floor is honoured", () => {
  const derived = getCostGuardrailLimits("Pro", PRO, {}).derived;
  const raised = String(derived.planDay * 2);
  const limits = getCostGuardrailLimits("Pro", PRO, {
    CHAT_COST_GUARDRAIL_PRO_PLAN_MICROUSD_PER_DAY: raised,
  });
  assert.equal(limits.planDay, Number(raised));
  assert.deepEqual(limits.clampedOverrides, []);
});

test("the retired per-user USD ceilings are named and detectable", () => {
  assert.ok(RETIRED_COST_LIMIT_ENV_NAMES.includes("CHAT_PRO_COST_MICROUSD_PER_DAY"));
  assert.ok(
    RETIRED_COST_LIMIT_ENV_NAMES.includes("CHAT_PRO_COST_MICROUSD_PER_MONTH")
  );
  assert.deepEqual(findRetiredCostLimitEnvNames({}), []);
  assert.deepEqual(
    findRetiredCostLimitEnvNames({
      CHAT_PRO_COST_MICROUSD_PER_DAY: "1500000",
      UNRELATED: "1",
    }),
    ["CHAT_PRO_COST_MICROUSD_PER_DAY"]
  );
});

test("setting a retired variable cannot lower the guardrail", () => {
  const limits = getCostGuardrailLimits("Pro", PRO, {
    CHAT_PRO_COST_MICROUSD_PER_DAY: "1500000",
    CHAT_PRO_COST_MICROUSD_PER_MONTH: "4500000",
  });
  assert.equal(limits.planDay, limits.derived.planDay);
  assert.equal(limits.planMonth, limits.derived.planMonth);
});

test("guest guardrails stay absolute and independently configured", () => {
  assert.deepEqual(getGuestCostGuardrailLimits({}), {
    day: 20_000,
    month: 100_000,
  });
});

// The Max plan's own default grant produces a total-cost guardrail past
// int4's 2,147,483,647 ceiling. `ChatUsageBucket."count"` used to be an `Int`,
// so acquireChatAccess bound that limit into the guardrail UPSERT as an int4
// parameter and PostgreSQL raised 22003 instead of returning an allow/deny
// decision -- every Max chat request failed. The column is BIGINT now
// (prisma/migrations/20260801130000_widen_chat_usage_bucket_count); this test
// pins the fact that the limits legitimately exceed int4, so nobody "fixes"
// the overflow by capping the guardrail back below what the plan can buy.
const INT4_MAX = 2_147_483_647;

test("the Max plan's derived guardrails exceed int4, so the counter must be 64-bit", () => {
  const limits = getCostGuardrailLimits("Max", MAX, {});
  assert.ok(
    limits.totalMonth > INT4_MAX,
    `expected the Max total-month guardrail to exceed int4, got ${limits.totalMonth}`
  );
  assert.equal(
    limits.totalMonth,
    10_000 *
      COST_PER_CREDIT_CEILING_MICRO_USD *
      GUARDRAIL_HEADROOM_MULTIPLIER *
      PURCHASED_CREDIT_HEADROOM_MULTIPLE
  );
});

test("int4 overflows for any plan above roughly 8,590 monthly credits", () => {
  // The exact boundary the defect sat on: below it the old int4 column
  // happened to hold, above it every request for that plan threw.
  const perCreditTotal =
    COST_PER_CREDIT_CEILING_MICRO_USD *
    GUARDRAIL_HEADROOM_MULTIPLIER *
    PURCHASED_CREDIT_HEADROOM_MULTIPLE;
  const lastSafeCredits = Math.floor(INT4_MAX / perCreditTotal);
  assert.equal(lastSafeCredits, 8_589);

  const safe = getCostGuardrailLimits("Custom", {
    dailyCreditLimit: 0,
    monthlyCreditLimit: lastSafeCredits,
  }, {});
  assert.ok(safe.totalMonth <= INT4_MAX);

  const overflowing = getCostGuardrailLimits("Custom", {
    dailyCreditLimit: 0,
    monthlyCreditLimit: lastSafeCredits + 1,
  }, {});
  assert.ok(overflowing.totalMonth > INT4_MAX);
});
