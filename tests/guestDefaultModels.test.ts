import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_DEFAULTS,
  createGuestEligibilityCheck,
  getGuestDefaultSelectedModels,
  GUEST_BRAND_TRIO_MODEL_IDS,
  guestDefaultLeadRejection,
  GUEST_FALLBACK_MODEL_IDS,
  resolveGuestDefaultSelectedModels,
} from "@/lib/appDefaults";
import {
  getModel,
  getModelUsageProfile,
  getWeightedUsageCredits,
  type AiModel,
} from "@/lib/models";

// The guest default and the credits shown for it are the same decision seen
// from two angles, so these lock down the resolver's shape (always three
// distinct guest-usable models) and the fact that the price is summed from
// that selection rather than tracked next to it. Nothing here hardcodes a
// credit total: the expected numbers are derived from the catalogue, so a
// change to any model's base cost updates both sides together.

const isGuestEligible = createGuestEligibilityCheck(getModel);

const baseCreditsFor = (modelIds: string[]) =>
  modelIds.reduce((sum, modelId) => {
    const model = getModel(modelId);
    return sum + (model ? getModelUsageProfile(model).credits : 0);
  }, 0);

// Mirrors what components/chat/ChatInput.tsx sums for the composer estimate.
const estimatedCreditsFor = (modelIds: string[], inputTokens = 1) =>
  modelIds.reduce((sum, modelId) => {
    const model = getModel(modelId);
    return sum + (model ? getWeightedUsageCredits(model, inputTokens) : 0);
  }, 0);

test("the guest default is the full brand trio", () => {
  const models = getGuestDefaultSelectedModels();

  assert.equal(models.length, APP_DEFAULTS.maxGuestSelectedModels);
  assert.equal(new Set(models).size, models.length);
  assert.deepEqual([...models].sort(), [...GUEST_BRAND_TRIO_MODEL_IDS].sort());
  for (const modelId of models) {
    assert.equal(isGuestEligible(modelId), true, modelId);
  }
});

test("the configured lead model only reorders the trio", () => {
  for (const leadModelId of GUEST_BRAND_TRIO_MODEL_IDS) {
    const models = getGuestDefaultSelectedModels(leadModelId);
    assert.equal(models[0], leadModelId);
    assert.deepEqual([...models].sort(), [...GUEST_BRAND_TRIO_MODEL_IDS].sort());
  }
});

test("a lead model outside the trio is ignored, not added", () => {
  const outsider = GUEST_FALLBACK_MODEL_IDS[0];
  assert.equal(GUEST_BRAND_TRIO_MODEL_IDS.includes(outsider), false);

  const models = getGuestDefaultSelectedModels(outsider);
  assert.equal(models.includes(outsider), false);
  assert.deepEqual([...models].sort(), [...GUEST_BRAND_TRIO_MODEL_IDS].sort());
});

test("an unavailable trio model is backfilled instead of shrinking the default", () => {
  const unavailable = GUEST_BRAND_TRIO_MODEL_IDS[1];
  const models = resolveGuestDefaultSelectedModels({
    isEligible: (modelId) => modelId !== unavailable && isGuestEligible(modelId),
  });

  assert.equal(models.length, APP_DEFAULTS.maxGuestSelectedModels);
  assert.equal(models.includes(unavailable), false);
  assert.equal(new Set(models).size, models.length);
  assert.equal(
    models.some((modelId) => GUEST_FALLBACK_MODEL_IDS.includes(modelId)),
    true
  );
});

test("an empty catalogue degrades to no selection rather than an invalid one", () => {
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ isEligible: () => false }),
    []
  );
});

test("guest eligibility rejects deleted, plan-locked and higher-tier models", () => {
  const trioModel = getModel(GUEST_BRAND_TRIO_MODEL_IDS[0]) as AiModel;
  const check = (overrides: Partial<AiModel>) =>
    createGuestEligibilityCheck(() => ({ ...trioModel, ...overrides }))(
      trioModel.id
    );

  assert.equal(check({}), true);
  assert.equal(check({ enabled: false }), false);
  assert.equal(check({ catalogDeleted: true }), false);
  assert.equal(check({ minimumPlan: "Pro" }), false);
  assert.equal(check({ usageClass: "premium", creditWeight: undefined }), false);
  assert.equal(createGuestEligibilityCheck(() => undefined)(trioModel.id), false);
});

test("estimated credits are the sum of the selected models' costs", () => {
  const models = getGuestDefaultSelectedModels();

  assert.equal(estimatedCreditsFor(models), baseCreditsFor(models));
  // Every guest-eligible model is Standard tier, so the trio's estimate is
  // one credit per selected model -- the "3 credits" a new guest is quoted.
  assert.equal(estimatedCreditsFor(models), models.length);

  // Deselecting and reselecting moves the estimate by exactly that model's
  // own cost, which is what makes a separately stored total impossible.
  const [dropped, ...remaining] = models;
  assert.equal(
    estimatedCreditsFor(remaining),
    estimatedCreditsFor(models) - estimatedCreditsFor([dropped])
  );
  assert.equal(estimatedCreditsFor([]), 0);
});

// The write side of the same decision. The resolver above already ignores a
// lead outside the trio; these are what stop that from being reachable at all,
// because a setting that saves and then does nothing is worse than one that
// refuses -- the administrator gets a success either way.

test("only a brand-trio model may be stored as the guest lead", () => {
  for (const modelId of GUEST_BRAND_TRIO_MODEL_IDS) {
    const model = getModel(modelId) as AiModel;
    assert.equal(
      guestDefaultLeadRejection({
        modelId,
        exists: true,
        guestEligible: true,
        usageCategory: getModelUsageProfile(model).category,
      }),
      null,
      modelId
    );
  }
});

test("an eligible model outside the trio is rejected as a no-op, not accepted", () => {
  const outsider = GUEST_FALLBACK_MODEL_IDS[0];
  assert.equal(
    isGuestEligible(outsider),
    true,
    "the fixture must pass every eligibility rule, so only the trio rule can reject it"
  );

  const rejection = guestDefaultLeadRejection({
    modelId: outsider,
    exists: true,
    guestEligible: true,
    usageCategory: "Standard",
  });
  assert.ok(rejection);
  assert.match(rejection, /stored but never applied/);
  // And the message has to name what would work, or it is just a refusal.
  for (const modelId of GUEST_BRAND_TRIO_MODEL_IDS) {
    assert.ok(rejection.includes(modelId), modelId);
  }
});

test("disabled, non-guest and non-Standard leads are each rejected on their own terms", () => {
  const lead = GUEST_BRAND_TRIO_MODEL_IDS[0];
  const base = {
    modelId: lead,
    exists: true,
    guestEligible: true,
    usageCategory: "Standard",
  };

  assert.match(
    guestDefaultLeadRejection({ ...base, exists: false }) ?? "",
    /not an enabled model/
  );
  assert.match(
    guestDefaultLeadRejection({ ...base, guestEligible: false }) ?? "",
    /not available to guests/
  );
  assert.match(
    guestDefaultLeadRejection({ ...base, usageCategory: "Premium" }) ?? "",
    /not Standard/
  );
  assert.match(
    guestDefaultLeadRejection({ ...base, usageCategory: null }) ?? "",
    /not Standard/
  );
});
