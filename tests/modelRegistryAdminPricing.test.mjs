import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelRegistrySchema,
  updateModelRegistrySchema,
} from "../lib/modelRegistryAdmin.ts";

// Whether the priced-premium rule holds for the catalogue that actually bills.
//
// `npm run check:model-pricing` proves it about `lib/models.ts` at CI time. The
// catalogue that prices a real request is ModelRegistryEntry, and an
// administrator creates rows and flips models to enabled long after CI ran --
// so the rule CI proved about one catalogue was never true of the other. An
// enabled premium model with no profile bills on the conservative class
// fallback, which is a guess, not its price.
//
// Enforced in the shared zod refinement rather than in each route: create,
// update and the validate endpoint all parse through it, and a fourth write
// path is how a per-route check stops covering everything.

const base = {
  name: "Test model",
  apiModel: "test-model",
  provider: "openai",
  icon: "",
  bestFor: "",
  minimumPlan: "Pro",
  creditWeight: 16,
  publiclyListed: true,
  operationalReason: "",
  userVisibleNote: "",
  supportsImage: false,
  supportsNativePdf: false,
  sortOrder: 0,
};

const create = (overrides) =>
  createModelRegistrySchema.safeParse({
    id: "an-unpriced-model",
    ...base,
    usageClass: "premium",
    status: "enabled",
    ...overrides,
  });

const messages = (result) =>
  result.success ? [] : result.error.issues.map((issue) => issue.message);

const PREMIUM_CLASSES = ["premium", "premium-reasoning", "deep-research"];
const CHEAPER_CLASSES = ["standard", "advanced", "reasoning", "research"];

for (const usageClass of PREMIUM_CLASSES) {
  test(`an enabled ${usageClass} model with no price is rejected`, () => {
    const result = create({ usageClass });
    assert.equal(result.success, false);
    assert.ok(
      messages(result).some((message) => /explicit price/.test(message)),
      `expected a pricing rejection, got ${JSON.stringify(messages(result))}`
    );
  });

  // "limited" is enabled: both routes derive `enabled` from
  // `status === "enabled" || status === "limited"`, and a limited model still
  // serves requests and still charges for them.
  test(`a limited ${usageClass} model is treated as enabled`, () => {
    assert.equal(create({ usageClass, status: "limited" }).success, false);
  });
}

for (const usageClass of CHEAPER_CLASSES) {
  test(`an enabled ${usageClass} model without a profile is allowed`, () => {
    // Their fallback is close enough to real list prices to be safe while a
    // profile is added, which is why findUnpricedModels grades them a warning.
    assert.equal(create({ usageClass }).success, true);
  });
}

test("a disabled premium model is not this rule's business", () => {
  assert.equal(create({ status: "disabled" }).success, true);
  assert.equal(create({ status: "coming-soon" }).success, true);
});

test("an explicit price on the row satisfies the rule", () => {
  const result = create({
    inputUsdPerMillionTokens: 1.25,
    outputUsdPerMillionTokens: 10,
  });
  assert.equal(result.success, true);
});

// Half a price is not a price: the resolver needs both ends, and accepting one
// would let a row bill the fallback for the other.
test("only one of the two prices does not satisfy the rule", () => {
  assert.equal(create({ inputUsdPerMillionTokens: 1.25 }).success, false);
  assert.equal(create({ outputUsdPerMillionTokens: 10 }).success, false);
});

test("a model with a profile in lib/modelPricing.ts is allowed", () => {
  const result = create({ id: "gpt-5-6-sol", usageClass: "premium" });
  assert.equal(
    result.success,
    true,
    `expected the profiled model to pass, got ${JSON.stringify(messages(result))}`
  );
});

// The update path is where an existing model is flipped to enabled, which is
// the move CI cannot see at all.
test("the update schema enforces the same rule", () => {
  const result = updateModelRegistrySchema.safeParse({
    ...base,
    usageClass: "premium",
    status: "enabled",
  });
  assert.equal(result.success, false);
  assert.ok(messages(result).some((message) => /explicit price/.test(message)));
});

test("the rejection points at usageClass, so the form can show it", () => {
  const result = create({});
  assert.equal(result.success, false);
  assert.ok(
    result.error.issues.some((issue) => issue.path.join(".") === "usageClass")
  );
});

// The rule must not swallow the refinements that were already there.
test("the existing reservation-token refinement still applies", () => {
  const result = create({
    id: "gpt-5-6-sol",
    maxOutputTokens: 100,
    reservationOutputTokens: 200,
  });
  assert.equal(result.success, false);
  assert.ok(
    messages(result).some((message) => /Reserved output tokens/.test(message))
  );
});
