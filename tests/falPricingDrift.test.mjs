import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateFalPricing,
  falPricingRequest,
} from "../scripts/check-fal-image-pricing-core.mjs";

const held = {
  id: "fal-ai/nano-banana-2",
  apiModelId: "fal-ai/nano-banana-2",
  disabledReason: "operational_hold",
  prices: [
    { quality: "medium", size: "1024x1024", credits: 120, outputCostMicroUsd: 80_000 },
  ],
};

const enabled = { ...held, disabledReason: null };

const priced = (overrides = {}) => ({
  prices: [
    {
      endpoint_id: "fal-ai/nano-banana-2",
      unit_price: 0.08,
      unit: "image",
      currency: "USD",
      ...overrides,
    },
  ],
});

test("the approved price is read from the registry, not restated here", () => {
  // A second copy of 0.08 in this file would be the thing that goes stale.
  assert.deepEqual(falPricingRequest(held), {
    endpointId: "fal-ai/nano-banana-2",
    approvedUnitPriceUsd: 0.08,
  });
});

test("a held model with no lookup is skipped, not passed", () => {
  // "Did not check" and "checked and agreed" are different facts, and a check
  // that reports success when it never ran is worse than one that fails.
  const verdict = evaluateFalPricing({ model: held, response: null });
  assert.equal(verdict.status, "skipped");
  assert.deepEqual(verdict.problems, []);
});

test("an enabled model with no lookup fails", () => {
  // The fail-closed case. The price is live, and "we could not look" is not a
  // reason to let it stand.
  const verdict = evaluateFalPricing({ model: enabled, response: null });
  assert.equal(verdict.status, "failed");
  assert.match(verdict.problems[0], /enabled but fal's published price could not be read/);
});

test("a matching price matches", () => {
  const verdict = evaluateFalPricing({ model: enabled, response: priced() });
  assert.equal(verdict.status, "matched");
  assert.deepEqual(verdict.problems, []);
});

test("a raised price fails, and says what it would cost", () => {
  const verdict = evaluateFalPricing({
    model: enabled,
    response: priced({ unit_price: 0.09 }),
  });
  assert.equal(verdict.status, "failed");
  assert.match(verdict.problems[0], /0\.09/);
  assert.match(verdict.problems[0], /cost more than the credit that was sold/);
});

test("a lowered price fails too", () => {
  // Not an obvious call, so it is stated: the 120 credits were set against
  // 0.08, and a cheaper input changes the margin the approval was given for.
  // Silently absorbing it means the approved number stops describing anything.
  const verdict = evaluateFalPricing({
    model: enabled,
    response: priced({ unit_price: 0.05 }),
  });
  assert.equal(verdict.status, "failed");
  assert.match(verdict.problems[0], /still needs re-approval/);
});

test("a change of billing unit fails even at the same number", () => {
  // The nastiest drift available: per-megapixel at 0.08 reads like no change
  // at all, while every credit calculation here -- arithmetic over one image --
  // becomes wrong by a factor nobody sees.
  const verdict = evaluateFalPricing({
    model: enabled,
    response: priced({ unit: "megapixel" }),
  });
  assert.equal(verdict.status, "failed");
  assert.match(verdict.problems[0], /per megapixel, not per image/);
});

test("a non-USD quote fails", () => {
  const verdict = evaluateFalPricing({
    model: enabled,
    response: priced({ currency: "EUR" }),
  });
  assert.equal(verdict.status, "failed");
  assert.ok(verdict.problems.some((problem) => problem.includes("EUR")));
});

test("an answer about a different endpoint is not an answer", () => {
  const verdict = evaluateFalPricing({
    model: enabled,
    response: priced({ endpoint_id: "fal-ai/flux/dev" }),
  });
  assert.equal(verdict.status, "failed");
  assert.match(verdict.problems[0], /returned no entry for fal-ai\/nano-banana-2/);
});

test("what this check cannot see is said, not omitted", () => {
  // 2,000 of the approved 87,000 worst case is the high-thinking surcharge,
  // and fal's pricing API answers with one unit price. A reader should not
  // come away thinking the surcharge was compared.
  const verdict = evaluateFalPricing({ model: enabled, response: priced() });
  assert.ok(
    verdict.notes.some((note) => note.includes("high-thinking surcharge is not exposed"))
  );
});

test("an enabled model with no price cannot be verified either way", () => {
  const verdict = evaluateFalPricing({
    model: { ...enabled, prices: [] },
    response: priced(),
  });
  assert.equal(verdict.status, "cannot_verify");
  assert.match(verdict.problems[0], /nothing to compare/);
});
