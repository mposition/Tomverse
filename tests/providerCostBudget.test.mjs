import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyProviderBudgetUtilisation,
  DEVELOPMENT_PROVIDER_BUDGET_MICRO_USD,
  findAlternativeModelsForBlockedProvider,
  findProviderBudgetProblems,
  getActiveProviders,
  getProviderBudgetReadiness,
  getProviderCostBudget,
  getProviderCostGuardrailLimits,
  getSingleAccountCostCeiling,
  providerBudgetEnvName,
  PROVIDER_BUDGET_UNIT_SUSPICION_MICRO_USD,
} from "../lib/providerCostBudget.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";

const production = (extra = {}) => ({ NODE_ENV: "production", ...extra });

// The floor: what one account's own plan guardrail allows. A provider-wide cap
// under this fires before a single legitimate account has spent its
// entitlement, which is the defect this module exists to make impossible.
const FLOOR = getSingleAccountCostCeiling({});

test("the floor is the largest single account's plan guardrail", () => {
  // Max: 10,000 monthly credits x 40,000 micro-USD x 1.25 headroom = US$500,
  // and no daily credit limit, so its day guardrail is its month guardrail.
  assert.equal(FLOOR.month, 500_000_000);
  assert.equal(FLOOR.day, 500_000_000);
});

test("the old silent defaults were below what one Pro account may spend", () => {
  // The regression this guards: US$10/day and US$100/month were the shipped
  // provider defaults, against a single Pro account's US$15/day, US$150/month.
  assert.ok(DEVELOPMENT_PROVIDER_BUDGET_MICRO_USD.day < 15_000_000);
  assert.ok(DEVELOPMENT_PROVIDER_BUDGET_MICRO_USD.month < 150_000_000);
  // ...and they can no longer take effect anywhere, because the floor wins.
  const budget = getProviderCostBudget("openai", {});
  assert.equal(budget.day, FLOOR.day);
  assert.equal(budget.month, FLOOR.month);
});

test("production has no default: an unset budget fails readiness", () => {
  const readiness = getProviderBudgetReadiness(["openai"], production());
  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.errors.map((problem) => problem.reason),
    ["missing_in_production", "missing_in_production"]
  );
  assert.match(readiness.errors[0].message, /CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY/);
});

test("outside production the same absence is not an error", () => {
  const readiness = getProviderBudgetReadiness(["openai"], {});
  assert.equal(readiness.ready, true);
  assert.equal(getProviderCostBudget("openai", {}).source, "development_fallback");
});

test("a configured budget below the floor is raised and reported", () => {
  const environment = production({
    CHAT_PROVIDER_ANTHROPIC_COST_MICROUSD_PER_DAY: "100000000", // US$100
    CHAT_PROVIDER_ANTHROPIC_COST_MICROUSD_PER_MONTH: "100000000",
  });
  const budget = getProviderCostBudget("anthropic", environment);
  assert.equal(budget.configured.day, 100_000_000);
  assert.equal(budget.day, FLOOR.day, "the enforced value is the floor");
  assert.deepEqual(budget.clampedPeriods, ["day", "month"]);
  const reasons = budget.problems.map((problem) => problem.reason);
  assert.deepEqual(reasons, [
    "below_single_account_ceiling",
    "below_single_account_ceiling",
  ]);
  // Clamping alone is not enough -- an operator who set US$100 has to be told,
  // or the number in force silently stops being the number they chose.
  assert.equal(getProviderBudgetReadiness(["anthropic"], environment).ready, false);
});

test("a budget at or above the floor is honoured exactly", () => {
  const environment = production({
    CHAT_PROVIDER_GOOGLE_COST_MICROUSD_PER_DAY: String(FLOOR.day),
    CHAT_PROVIDER_GOOGLE_COST_MICROUSD_PER_MONTH: "9000000000",
  });
  const budget = getProviderCostBudget("google", environment);
  assert.equal(budget.day, FLOOR.day);
  assert.equal(budget.month, 9_000_000_000);
  assert.deepEqual(budget.problems, []);
  assert.equal(budget.source, "configured");
  assert.deepEqual(getProviderCostGuardrailLimits("google", environment), {
    day: FLOOR.day,
    month: 9_000_000_000,
  });
});

test("dollars written where micro-USD was meant are caught", () => {
  // 500 means five hundredths of a cent, not US$500. Left uncaught, the floor
  // would quietly rescue the value and nobody would learn the unit was wrong.
  const problems = findProviderBudgetProblems(
    ["xai"],
    production({
      CHAT_PROVIDER_XAI_COST_MICROUSD_PER_DAY: "500",
      CHAT_PROVIDER_XAI_COST_MICROUSD_PER_MONTH: "5000",
    })
  );
  const reasons = problems.map((problem) => problem.reason);
  assert.ok(reasons.includes("looks_like_dollars"));
  assert.ok(PROVIDER_BUDGET_UNIT_SUSPICION_MICRO_USD === 1_000_000);
});

test("a malformed budget is an error rather than a silent fallback", () => {
  for (const raw of ["abc", "-1", "0", "1.5", "US$500", "500_000"]) {
    const problems = findProviderBudgetProblems(
      ["mistral"],
      production({
        CHAT_PROVIDER_MISTRAL_COST_MICROUSD_PER_DAY: raw,
        CHAT_PROVIDER_MISTRAL_COST_MICROUSD_PER_MONTH: "9000000000",
      })
    );
    assert.ok(
      problems.some((problem) => problem.reason === "not_a_positive_integer"),
      `${raw} was accepted`
    );
  }
});

test("a daily budget above the monthly one is rejected", () => {
  const problems = findProviderBudgetProblems(
    ["qwen"],
    production({
      CHAT_PROVIDER_QWEN_COST_MICROUSD_PER_DAY: "9000000000",
      CHAT_PROVIDER_QWEN_COST_MICROUSD_PER_MONTH: "1000000000",
    })
  );
  assert.ok(problems.some((problem) => problem.reason === "day_above_month"));
});

test("env names follow the documented shape", () => {
  assert.equal(
    providerBudgetEnvName("openai", "day"),
    "CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY"
  );
  assert.equal(
    providerBudgetEnvName("perplexity", "month"),
    "CHAT_PROVIDER_PERPLEXITY_COST_MICROUSD_PER_MONTH"
  );
});

test("active providers are the ones a request can actually reach", () => {
  const active = getActiveProviders(AVAILABLE_MODELS);
  assert.ok(active.includes("openai"));
  assert.ok(active.length > 1);
  assert.equal(new Set(active).size, active.length);
  // A provider whose every model is disabled cannot spend anything, so
  // requiring a budget for it would only invite unused configuration.
  assert.deepEqual(
    getActiveProviders([
      { provider: "openai", enabled: true },
      { provider: "groq", enabled: false },
      { provider: "xai", status: "disabled" },
    ]),
    ["openai"]
  );
});

test("utilisation counts the request in hand, not just what is spent", () => {
  const at = (used, required) =>
    classifyProviderBudgetUtilisation({
      usedMicroUsd: used,
      requiredMicroUsd: required,
      limitMicroUsd: 1_000_000,
    }).level;
  assert.equal(at(0, 0), "nominal");
  assert.equal(at(690_000, 0), "nominal");
  assert.equal(at(700_000, 0), "notice");
  // The report that only looks backwards always arrives late: a request that
  // will cross the threshold is the one worth reporting.
  assert.equal(at(690_000, 20_000), "notice");
  assert.equal(at(850_000, 0), "warning");
  assert.equal(at(950_000, 0), "critical");
  assert.equal(at(1_000_000, 0), "critical", "exactly at the limit still fits");
  assert.equal(at(1_000_000, 1), "exhausted");
});

test("a zero limit is exhausted rather than dividing by zero", () => {
  const result = classifyProviderBudgetUtilisation({
    usedMicroUsd: 0,
    requiredMicroUsd: 0,
    limitMicroUsd: 0,
  });
  assert.equal(result.ratio, 1);
  assert.equal(result.level, "exhausted");
});

test("alternatives for a blocked provider never point back at it", () => {
  const models = [
    { id: "a", provider: "openai" },
    { id: "b", provider: "google" },
    { id: "c", provider: "anthropic" },
    { id: "retired", provider: "google", enabled: false },
    { id: "off", provider: "mistral", status: "disabled" },
  ];
  assert.deepEqual(
    findAlternativeModelsForBlockedProvider({
      blockedProvider: "openai",
      candidateModelIds: ["a", "retired", "off", "b", "c"],
      models,
    }),
    ["b", "c"]
  );
  assert.deepEqual(
    findAlternativeModelsForBlockedProvider({
      blockedProvider: "openai",
      candidateModelIds: ["unknown-model"],
      models,
    }),
    []
  );
});

test("the shipped fallback table survives the same filter", () => {
  // Every active provider's refusal has to be able to name a way out; a
  // fallback list that resolves to nothing leaves the user with a bare 503.
  for (const provider of getActiveProviders(AVAILABLE_MODELS)) {
    const budget = getProviderCostBudget(provider, {});
    assert.ok(budget.day > 0 && budget.month > 0, provider);
  }
});

test("the policy document records the provider budget contract", () => {
  const policy = readFileSync("docs/policy/credit-and-cost-limits.md", "utf8");
  assert.match(policy, /CHAT_PROVIDER_/);
  assert.match(policy, /PROVIDER_BUDGET_EXHAUSTED/);
  assert.match(policy, /getSingleAccountCostCeiling|단일 계정/);
  assert.match(policy, /70/);
  assert.match(policy, /readiness|\/api\/ready/);
  assert.match(policy, /\/api\/admin\/provider-budgets/);
});
