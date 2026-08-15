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
  worstImageCostPerCreditFrom,
  worstImageCostPerCreditMicroUsd,
} from "../lib/imageProviderBudget.ts";
import { IMAGE_MODEL_REGISTRY } from "../lib/imageModelRegistry.ts";
import { IMAGE_GENERATION_PRICING } from "../lib/imageGenerationPricing.ts";

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

test("both price lists feed the floor, not only gpt-image-2's table", () => {
  // There are two lists. IMAGE_GENERATION_PRICING is gpt-image-2's original
  // table; every model added since carries its prices on its registry profile.
  // Reading only the first kept returning the right number for the wrong
  // reason -- gpt-image-2 Final simply happens to be the priciest credit -- so
  // xAI shipped enabled without ever entering the derivation, and adding a
  // costlier model would have left the floor where it was.
  const enabled = IMAGE_MODEL_REGISTRY.filter(
    (model) => model.disabledReason === null
  );
  assert.equal(worstImageCostPerCreditFrom(IMAGE_GENERATION_PRICING, enabled), 864);

  // xAI today: (50,000 + 5,000 prompt budget + 0 thinking) / 75 = 734, under
  // Final's 864 -- present in the derivation, just not the maximum.
  const grok = enabled.find((model) => model.provider === "xai");
  assert.equal(worstImageCostPerCreditFrom([], [grok]), 734);

  // The regression this exists for: a model priced above the current worst
  // must raise the floor. Same shape as Grok, twice the cost per credit.
  const costlier = {
    ...grok,
    id: "hypothetical-expensive-image",
    prices: [{ ...grok.prices[0], outputCostMicroUsd: 145_000 }],
  };
  assert.equal(
    worstImageCostPerCreditFrom(IMAGE_GENERATION_PRICING, [...enabled, costlier]),
    2_000
  );
  assert.ok(
    worstImageCostPerCreditFrom(IMAGE_GENERATION_PRICING, [...enabled, costlier]) >
      worstImageCostPerCreditMicroUsd()
  );
});

test("an enabled model with an unbounded worst case refuses to derive a floor", () => {
  // Skipping it would compute the floor from everything except the model the
  // floor exists to cover. check:image-pricing forbids enabling one; this is
  // the in-process backstop for a registry edit that gets past it.
  const held = IMAGE_MODEL_REGISTRY.find(
    (model) => model.priceVerification.thinkingCapMicroUsd === null
  );
  const wronglyEnabled = {
    ...held,
    disabledReason: null,
    prices: [{ quality: "medium", size: "1024x1024", credits: 190, outputCostMicroUsd: 67_000 }],
  };
  assert.throws(
    () => worstImageCostPerCreditFrom(IMAGE_GENERATION_PRICING, [wronglyEnabled]),
    /worst-case cost is unbounded/
  );
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
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "120000000",
      IMAGE_PROVIDER_XAI_COST_MICROUSD_PER_DAY: "50000000",
      IMAGE_PROVIDER_XAI_COST_MICROUSD_PER_MONTH: "500000000",
      // The canary figures approved 2026-08-14: $12/day, $50/month.
      IMAGE_PROVIDER_FAL_COST_MICROUSD_PER_DAY: "12000000",
      IMAGE_PROVIDER_FAL_COST_MICROUSD_PER_MONTH: "50000000",
    },
    { production: true }
  );
  // OpenAI, xAI and fal each have an enabled model. The three Google models are
  // registered but on a price hold, so they cannot receive a request and their
  // missing budget must not block a deploy.
  //
  // fal is here as a *provider*, not as an owner: Nano Banana 2 is Google's
  // model, and a fal request drawing on IMAGE_PROVIDER_GOOGLE_COST_* would
  // still add up -- just against a pool with no money in it.
  assert.deepEqual(
    resolved.map((entry) => entry.provider),
    ["openai", "xai", "fal"]
  );
  for (const entry of resolved) assert.ok(entry.resolved.limits, entry.provider);
});

test("an enabled provider with no budget refuses readiness in production", () => {
  // The other half of the same rule, and the reason the environment variables
  // are deployed before the code that enables a model: the moment xAI has an
  // enabled model, an environment running with the flag on and no xAI budget
  // is a fatal misconfiguration rather than a quiet default.
  const resolved = resolveActiveImageProviderBudgets(
    {
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "12000000",
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "120000000",
    },
    { production: true }
  );
  const xai = resolved.find((entry) => entry.provider === "xai");
  assert.ok(xai, "xai is an active provider");
  assert.equal(xai.resolved.limits, null);
  assert.deepEqual(
    xai.resolved.problems.map((problem) => problem.reason),
    ["missing_in_production", "missing_in_production"]
  );
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

test("a month budget that is not above the day budget is flagged, not blocked", () => {
  // Both windows at the same number is legal and almost never intended: one
  // day spent at the daily cap exhausts the month, so the monthly window stops
  // being a second bound. It is deliberate in staging, where a small identical
  // pair caps total spend -- which is exactly why this advises rather than
  // refusing readiness. Refusing to start over an odd-but-conservative budget
  // would be worse than the budget.
  const equal = resolveImageProviderBudget(
    {
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "10800000",
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "10800000",
    },
    { production: true }
  );
  assert.ok(equal.limits, "still usable");
  assert.deepEqual(equal.problems, []);
  assert.deepEqual(
    equal.advisories.map((entry) => entry.code),
    ["month_not_above_day"]
  );

  // A month below the day is the same mistake, further along.
  const inverted = resolveImageProviderBudget(
    {
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "50000000",
      IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "20000000",
    },
    { production: true }
  );
  assert.deepEqual(
    inverted.advisories.map((entry) => entry.code),
    ["month_not_above_day"]
  );

  // The approved production pair says nothing.
  const approved = resolveImageProviderBudget(
    {
      IMAGE_PROVIDER_XAI_COST_MICROUSD_PER_DAY: "50000000",
      IMAGE_PROVIDER_XAI_COST_MICROUSD_PER_MONTH: "500000000",
    },
    { production: true, provider: "xai" }
  );
  assert.deepEqual(approved.advisories, []);
  assert.deepEqual(approved.limits, { day: 50_000_000, month: 500_000_000 });
});
