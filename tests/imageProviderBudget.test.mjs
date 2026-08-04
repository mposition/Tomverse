import assert from "node:assert/strict";
import { test } from "node:test";

import {
  imageProviderBudgetEnvNames,
  resolveActiveImageProviderBudgets,
  IMAGE_BUDGET_HEADROOM_MULTIPLIER,
  IMAGE_PROVIDER_BUDGET_ENV_NAMES,
  imageCostCeilingHeadroomMicroUsd,
  imageProviderBudgetFloorMicroUsd,
  resolveImageProviderBudget,
  worstImageCostPerCreditMicroUsd,
} from "../lib/imageProviderBudget.ts";

const DAY = IMAGE_PROVIDER_BUDGET_ENV_NAMES.day;
const MONTH = IMAGE_PROVIDER_BUDGET_ENV_NAMES.month;

test("the floor derives from the image price list, not the chat guardrail", () => {
  // Worst enabled entry is Final square: (211,000 + 5,000) / 250 = 864.
  assert.equal(worstImageCostPerCreditMicroUsd(), 864);
  assert.equal(IMAGE_BUDGET_HEADROOM_MULTIPLIER, 1.25);
  // Max plan 10,000 monthly credits x 864 x 1.25 = US$10.80 -- fifty times
  // smaller than the chat-derived Max plan floor, which is the whole reason
  // this module exists.
  assert.equal(imageProviderBudgetFloorMicroUsd(), 10_800_000);
  // 900 ceiling - 864 worst = 36 microUSD of headroom (about 4.2%).
  assert.equal(imageCostCeilingHeadroomMicroUsd(), 36);
});

test("valid environment values pass through; below-floor values clamp up and are reported", () => {
  const resolved = resolveImageProviderBudget(
    { [DAY]: "12000000", [MONTH]: "5000000" },
    { production: true }
  );
  assert.equal(resolved.source, "environment");
  assert.deepEqual(resolved.limits, { day: 12_000_000, month: 10_800_000 });
  assert.deepEqual(resolved.clamped, [
    {
      window: "month",
      configuredMicroUsd: 5_000_000,
      effectiveMicroUsd: 10_800_000,
    },
  ]);
  assert.equal(resolved.problems.length, 0);
});

test("missing in production fails closed with no invented default", () => {
  const resolved = resolveImageProviderBudget({}, { production: true });
  assert.equal(resolved.limits, null);
  assert.equal(resolved.source, "unconfigured");
  assert.deepEqual(
    resolved.problems.map((problem) => problem.reason),
    ["missing_in_production", "missing_in_production"]
  );
});

test("a partial configuration is a misconfiguration, not half a budget", () => {
  const resolved = resolveImageProviderBudget(
    { [MONTH]: "50000000" },
    { production: true }
  );
  assert.equal(resolved.limits, null);
  assert.equal(resolved.problems[0]?.reason, "partial_configuration");
  assert.equal(resolved.problems[0]?.window, "day");
});

test("a non-integer value is rejected in every environment", () => {
  for (const production of [true, false]) {
    const resolved = resolveImageProviderBudget(
      { [DAY]: "10.80", [MONTH]: "100000000" },
      { production }
    );
    assert.equal(resolved.limits, null);
    assert.equal(resolved.problems[0]?.reason, "not_a_positive_integer");
  }
});

test("development defaults exist and never sit below the floor", () => {
  const resolved = resolveImageProviderBudget({}, { production: false });
  assert.equal(resolved.source, "development_default");
  assert.ok(resolved.limits);
  assert.ok(resolved.limits.day >= imageProviderBudgetFloorMicroUsd());
  assert.ok(resolved.limits.month >= imageProviderBudgetFloorMicroUsd());
});

test("budget env names are per provider, never per model", () => {
  assert.deepEqual(imageProviderBudgetEnvNames("openai"), {
    day: "IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY",
    month: "IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH",
  });
  assert.deepEqual(imageProviderBudgetEnvNames("google"), {
    day: "IMAGE_PROVIDER_GOOGLE_COST_MICROUSD_PER_DAY",
    month: "IMAGE_PROVIDER_GOOGLE_COST_MICROUSD_PER_MONTH",
  });
});

test("only providers with an enabled model are required to have a budget", () => {
  const resolved = resolveActiveImageProviderBudgets(
    {
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "12000000",
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "12000000",
    },
    { production: true }
  );
  // Google is registered but on a price hold, so it cannot receive a request
  // and its missing budget must not block a deploy.
  assert.deepEqual(
    resolved.map((entry) => entry.provider),
    ["openai"]
  );
  assert.ok(resolved[0].resolved.limits);
});

test("a provider-scoped resolve reads that provider's variables only", () => {
  const google = resolveImageProviderBudget(
    {
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "12000000",
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "12000000",
    },
    { production: true, provider: "google" }
  );
  assert.equal(google.limits, null);
  assert.ok(
    google.problems.every((problem) =>
      problem.message.includes("IMAGE_PROVIDER_GOOGLE_")
    )
  );
});
