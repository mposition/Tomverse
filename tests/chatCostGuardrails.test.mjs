import assert from "node:assert/strict";
import test from "node:test";
import {
  COST_PER_CREDIT_CEILING_MICRO_USD,
  findRetiredCostLimitEnvNames,
  getCostGuardrailLimits,
  getGuestCostGuardrailLimits,
  getProviderCostGuardrailLimits,
  GUARDRAIL_HEADROOM_MULTIPLIER,
  MAX_USAGE_BUCKET_COUNT,
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

test("no guardrail can exceed the usage bucket's integer column", () => {
  // ChatUsageBucket.count is a Postgres `integer`. A limit past its range does
  // not loosen the guardrail, it makes the reservation query fail with
  // `value ... is out of range for type integer` and rejects every request on
  // that plan. Max's derived total-cost guardrail lands past it, so this clamp
  // is load-bearing.
  const plans = [
    ["Free", FREE],
    ["Pro", PRO],
    ["Max", MAX],
    // A pathological plan configuration must not be able to break it either.
    ["Max", { dailyCreditLimit: 0, monthlyCreditLimit: 10_000_000 }],
  ];
  for (const [plan, entitlement] of plans) {
    const limits = getCostGuardrailLimits(plan, entitlement, {});
    for (const [name, value] of Object.entries(limits)) {
      if (typeof value !== "number") continue;
      assert.ok(
        Number.isSafeInteger(value) && value > 0 && value <= MAX_USAGE_BUCKET_COUNT,
        `${plan} ${name} = ${value} is outside the usage bucket range`
      );
    }
    for (const value of Object.values(limits.derived)) {
      assert.ok(value <= MAX_USAGE_BUCKET_COUNT);
    }
  }

  assert.equal(
    getCostGuardrailLimits("Max", MAX, {}).totalMonth,
    MAX_USAGE_BUCKET_COUNT
  );
});

test("an environment override above the column range is clamped down", () => {
  const limits = getCostGuardrailLimits("Pro", PRO, {
    CHAT_COST_GUARDRAIL_PRO_TOTAL_MICROUSD_PER_MONTH: "999999999999",
  });
  assert.equal(limits.totalMonth, MAX_USAGE_BUCKET_COUNT);
});

test("guest and provider guardrails stay absolute and independently configured", () => {
  assert.deepEqual(getGuestCostGuardrailLimits({}), {
    day: 20_000,
    month: 100_000,
  });
  assert.deepEqual(getProviderCostGuardrailLimits("openai", {}), {
    day: 10_000_000,
    month: 100_000_000,
  });
  assert.deepEqual(
    getProviderCostGuardrailLimits("google", {
      CHAT_PROVIDER_GOOGLE_COST_MICROUSD_PER_DAY: "5000000",
    }),
    { day: 5_000_000, month: 100_000_000 }
  );
});
