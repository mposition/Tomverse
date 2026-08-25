import assert from "node:assert/strict";
import test from "node:test";

import { registryRowToModel } from "../lib/modelRegistry.ts";
import {
  OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS,
  RESERVATION_ONLY_RECONCILIATION_MODEL_IDS,
  staticModelRegistryReconciliationRows,
  staticModelRegistrySeedRows,
} from "../lib/modelRegistryShared.ts";
import { FALLBACK_PRICING, getModelCostClass } from "../lib/modelPricing.ts";
import { createChatBudget } from "../lib/chatSecurity.ts";
import { fitChatOutputToContextWindow } from "../lib/chatContextWindow.ts";

// Trace 2e4327a9, reproduced without a provider call.
//
// The chain the incident ran down is entirely local arithmetic: a registry row
// holds a number, `registryRowToModel()` prefers it over the pricing profile,
// `createChatBudget()` carries it into the turn, `fitChatOutputToContextWindow()`
// lowers it to the room the window has left, and app/api/chat/route.ts hands
// that figure to `streamText({ maxOutputTokens })`. Nothing in that path talks
// to Anthropic, so the cap a given row produces is checkable for free -- which
// is the only reason this regression is cheap enough to pin.
//
// Numbers from the incident: 16,314 input tokens, a 4,096-token cap, 4,095 of
// them spent on reasoning, no visible text, AI_EMPTY_RESPONSE.MAX_TOKENS.
const MODEL_ID = "claude-sonnet-5";
const INCIDENT_INPUT_TOKENS = 16_314;
const STALE_MAX_OUTPUT_TOKENS = 4_096;
const APPROVED_MAX_OUTPUT_TOKENS = 128_000;
const APPROVED_RESERVATION_OUTPUT_TOKENS = 2_048;

const seedRow = () => {
  const row = staticModelRegistrySeedRows().find((entry) => entry.id === MODEL_ID);
  assert.ok(row, `${MODEL_ID} must be in the bootstrap catalogue`);
  // The two columns Prisma fills in that the seed shape does not name. The
  // actor columns are what `report:model-token-limits` reads to tell a
  // stranded seed value apart from an administrator's decision, and neither
  // seeding nor reconciliation ever writes them.
  return { ...row, updatedById: null, updatedByEmail: null };
};

const requestOutputCapFor = (row) => {
  const model = registryRowToModel(row);
  const budget = createChatBudget("user", model, INCIDENT_INPUT_TOKENS);
  const fitted = fitChatOutputToContextWindow({
    contextWindowTokens: model.contextWindowTokens,
    reservedInputTokens: budget.inputTokens,
    requestOutputCapTokens: budget.maxOutputTokens,
    providerMaxOutputTokens: budget.providerMaxOutputTokens,
  });
  assert.notEqual(
    fitted.kind,
    "exceeded",
    "a 16,314-token prompt must leave room to answer in"
  );
  return { budget, requestMaxOutputTokens: fitted.outputTokens };
};

test("the pre-fix registry row is what capped the answer at 4,096 tokens", () => {
  // The shape production was in: seeded 2026-07-17 from
  // FALLBACK_PRICING.advanced, because claude-sonnet-5 had no pricing profile
  // until 2026-08-04.
  const { budget, requestMaxOutputTokens } = requestOutputCapFor({
    ...seedRow(),
    maxOutputTokens: STALE_MAX_OUTPUT_TOKENS,
    reservationOutputTokens: APPROVED_RESERVATION_OUTPUT_TOKENS,
  });

  assert.equal(budget.maxOutputTokens, STALE_MAX_OUTPUT_TOKENS);
  assert.equal(requestMaxOutputTokens, STALE_MAX_OUTPUT_TOKENS);
  // And the row wins over the profile even though lib/modelPricing.ts has said
  // 128,000 since 2026-08-04 -- which is the whole defect. These two columns
  // have no NULL-means-inherit rule; a stored number is simply obeyed.
  assert.notEqual(budget.maxOutputTokens, APPROVED_MAX_OUTPUT_TOKENS);
});

test("the reconciled row lifts the request cap to the approved 128,000", () => {
  const reconciliation = staticModelRegistryReconciliationRows().find(
    (entry) => entry.id === MODEL_ID
  );
  assert.ok(reconciliation, `${MODEL_ID} must be reconciled`);

  // The row after `reconcileStaticCatalogMetadata()` has written to it: the
  // stale values, then the reconciliation payload applied exactly as Prisma
  // would apply it.
  const { budget, requestMaxOutputTokens } = requestOutputCapFor({
    ...seedRow(),
    maxOutputTokens: STALE_MAX_OUTPUT_TOKENS,
    reservationOutputTokens: APPROVED_RESERVATION_OUTPUT_TOKENS,
    ...reconciliation.data,
  });

  assert.equal(budget.maxOutputTokens, APPROVED_MAX_OUTPUT_TOKENS);
  assert.equal(requestMaxOutputTokens, APPROVED_MAX_OUTPUT_TOKENS);
  // A 16,314-token prompt with 4,095 tokens of reasoning now has 123,904
  // tokens left to answer in, so the turn that returned nothing has room.
  assert.ok(requestMaxOutputTokens > INCIDENT_INPUT_TOKENS);
});

test("reconciling the output cap moves neither the reservation nor the credits", () => {
  const reconciliation = staticModelRegistryReconciliationRows().find(
    (entry) => entry.id === MODEL_ID
  );
  const before = requestOutputCapFor({
    ...seedRow(),
    maxOutputTokens: STALE_MAX_OUTPUT_TOKENS,
    reservationOutputTokens: APPROVED_RESERVATION_OUTPUT_TOKENS,
  }).budget;
  const after = requestOutputCapFor({
    ...seedRow(),
    maxOutputTokens: STALE_MAX_OUTPUT_TOKENS,
    reservationOutputTokens: APPROVED_RESERVATION_OUTPUT_TOKENS,
    ...reconciliation.data,
  }).budget;

  // What a turn holds against the user's credits and against the provider
  // budget is unchanged. Raising the cap is a capability fix; raising the
  // reservation would be an entitlement change, and the two are not allowed
  // to travel together (docs/policy/credit-and-cost-limits.md).
  assert.equal(before.reservedOutputTokens, APPROVED_RESERVATION_OUTPUT_TOKENS);
  assert.equal(after.reservedOutputTokens, APPROVED_RESERVATION_OUTPUT_TOKENS);
  assert.equal(after.usageCredits, before.usageCredits);
  assert.equal(after.inputTokens, before.inputTokens);
  assert.equal(
    after.inputUsdPerMillionTokens,
    before.inputUsdPerMillionTokens
  );
  assert.equal(
    after.outputUsdPerMillionTokens,
    before.outputUsdPerMillionTokens
  );
  assert.equal(after.pricingVersion, before.pricingVersion);
});

test("a NULL token column still inherits the pricing profile", () => {
  // The other half of the contract the report has to model: a row that stores
  // nothing is not drifting, because registryRowToModel() drops the column and
  // lib/modelPricing.ts supplies the number. Only a stored number can strand.
  const { budget } = requestOutputCapFor({
    ...seedRow(),
    maxOutputTokens: null,
    reservationOutputTokens: null,
  });
  assert.equal(budget.maxOutputTokens, APPROVED_MAX_OUTPUT_TOKENS);
  assert.equal(
    budget.reservedOutputTokens,
    APPROVED_RESERVATION_OUTPUT_TOKENS
  );
});

// The 2026-08-23 sweep: twelve more models in the same shape. Same proof, run
// over each of them -- the pre-profile row caps the request, the reconciled
// row does not, and nothing about what the turn costs moves in between.
const seedRowFor = (modelId) => {
  const row = staticModelRegistrySeedRows().find((entry) => entry.id === modelId);
  assert.ok(row, `${modelId} must be in the bootstrap catalogue`);
  return { ...row, updatedById: null, updatedByEmail: null };
};

for (const modelId of OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS) {
  test(`${modelId}: the stranded class cap is lifted, and nothing else moves`, () => {
    const seeded = seedRowFor(modelId);
    const model = registryRowToModel(seeded);
    const fallback = FALLBACK_PRICING[getModelCostClass(model.usageClass)];
    const approvedCap = seeded.maxOutputTokens;

    // The row a pre-profile seed left behind.
    assert.ok(
      fallback.maxOutputTokens < approvedCap,
      `${modelId} must actually have a cap to lift`
    );
    const before = requestOutputCapFor({
      ...seeded,
      maxOutputTokens: fallback.maxOutputTokens,
      reservationOutputTokens: fallback.reservationOutputTokens,
    });
    assert.equal(before.budget.maxOutputTokens, fallback.maxOutputTokens);

    const reconciliation = staticModelRegistryReconciliationRows().find(
      (entry) => entry.id === modelId
    );
    assert.ok(reconciliation, modelId);
    const after = requestOutputCapFor({
      ...seeded,
      maxOutputTokens: fallback.maxOutputTokens,
      reservationOutputTokens: fallback.reservationOutputTokens,
      ...reconciliation.data,
    });

    assert.equal(after.budget.maxOutputTokens, approvedCap);
    assert.ok(after.requestMaxOutputTokens > before.requestMaxOutputTokens);

    // The cap is a capability. Credits, the reservation and the unit prices
    // are entitlement and cost, and this change does not touch them.
    assert.equal(after.budget.usageCredits, before.budget.usageCredits);
    assert.equal(
      after.budget.reservedOutputTokens,
      before.budget.reservedOutputTokens
    );
    assert.equal(
      after.budget.inputUsdPerMillionTokens,
      before.budget.inputUsdPerMillionTokens
    );
    assert.equal(
      after.budget.outputUsdPerMillionTokens,
      before.budget.outputUsdPerMillionTokens
    );
    assert.equal(after.budget.pricingVersion, before.budget.pricingVersion);
  });
}

// The acute pair: reasoning can fill the whole cap before a word of visible
// text, which is how the defect turns into an empty answer rather than a
// truncated one.
test("the two reasoning Perplexity models get room to answer after reasoning", () => {
  for (const modelId of [
    "perplexity/sonar-reasoning-pro",
    "perplexity/sonar-deep-research",
  ]) {
    const seeded = seedRowFor(modelId);
    const model = registryRowToModel(seeded);
    assert.equal(model.reasoning, "high", modelId);

    const fallback = FALLBACK_PRICING[getModelCostClass(model.usageClass)];
    const reconciliation = staticModelRegistryReconciliationRows().find(
      (entry) => entry.id === modelId
    );
    const { requestMaxOutputTokens } = requestOutputCapFor({
      ...seeded,
      maxOutputTokens: fallback.maxOutputTokens,
      ...reconciliation.data,
    });

    // Trace 2e4327a9 spent 4,095 reasoning tokens and had nothing left. Every
    // one of these now clears that by more than an order of magnitude.
    assert.ok(requestMaxOutputTokens > 100_000, modelId);
    assert.ok(
      requestMaxOutputTokens - 4_095 > fallback.maxOutputTokens,
      modelId
    );
  }
});

// The mirror image, and the cases where a reconciliation entry deliberately
// does move a money figure. docs/policy/credit-and-cost-limits.md section 4
// already fixed the figures -- "premium 4,096, reasoning 6,144" -- so a row
// holding less than that is holding a class default, not a decision.
//
// `staleReservation` is what the production row actually holds, and the two
// sources differ. gpt-5-5-thinking holds today's premium class fallback
// (4,096). gpt-5-5 and gemini-3-1-pro hold 2,048, which is what
// BILLING_DEFAULTS.premium in lib/models.ts read on 2026-07-17, before
// lib/modelPricing.ts existed -- so it cannot be derived from FALLBACK_PRICING
// as it stands now and is written out instead.
const RESERVATION_ONLY_CASES = {
  "gpt-5-5-thinking": { staleReservation: 4_096, approved: 6_144, heldRatio: 1.5 },
  "gpt-5-5": { staleReservation: 2_048, approved: 4_096, heldRatio: 2 },
  "gemini-3-1-pro": { staleReservation: 2_048, approved: 4_096, heldRatio: 2 },
};

test("each reservation-only row rises to its approved figure, and no cap moves", () => {
  assert.deepEqual(
    [...RESERVATION_ONLY_RECONCILIATION_MODEL_IDS].sort(),
    Object.keys(RESERVATION_ONLY_CASES).sort()
  );

  for (const [modelId, expectation] of Object.entries(RESERVATION_ONLY_CASES)) {
    const seeded = seedRowFor(modelId);
    const model = registryRowToModel(seeded);
    const fallback = FALLBACK_PRICING[getModelCostClass(model.usageClass)];
    assert.equal(
      fallback.maxOutputTokens,
      seeded.maxOutputTokens,
      `${modelId}: the cap agrees, which is why it is not in the cap-only scope`
    );

    const stale = {
      ...seeded,
      maxOutputTokens: fallback.maxOutputTokens,
      reservationOutputTokens: expectation.staleReservation,
    };
    const before = requestOutputCapFor(stale);
    assert.equal(
      before.budget.reservedOutputTokens,
      expectation.staleReservation,
      modelId
    );

    const reconciliation = staticModelRegistryReconciliationRows().find(
      (entry) => entry.id === modelId
    );
    assert.ok(reconciliation, modelId);
    const after = requestOutputCapFor({ ...stale, ...reconciliation.data });

    // The one number this entry exists to carry.
    assert.equal(after.budget.reservedOutputTokens, expectation.approved, modelId);
    // The request cap is untouched -- the answer may be exactly as long as
    // before. This changes what a turn *holds*, not what it may produce.
    assert.equal(
      after.budget.maxOutputTokens,
      before.budget.maxOutputTokens,
      modelId
    );
    assert.equal(
      after.requestMaxOutputTokens,
      before.requestMaxOutputTokens,
      modelId
    );

    // Credits charged to the user are weighted by the conversation, not by the
    // reservation, so the price of a turn is unchanged.
    assert.equal(after.budget.usageCredits, before.budget.usageCredits, modelId);
    assert.equal(
      after.budget.inputUsdPerMillionTokens,
      before.budget.inputUsdPerMillionTokens,
      modelId
    );
    assert.equal(
      after.budget.outputUsdPerMillionTokens,
      before.budget.outputUsdPerMillionTokens,
      modelId
    );

    // What does move: the internal cost held up front, refunded at settlement.
    // Stating it as a number so the review is about a known quantity rather
    // than about the direction alone.
    const heldBefore =
      before.budget.reservedOutputTokens *
      before.budget.outputUsdPerMillionTokens;
    const heldAfter =
      after.budget.reservedOutputTokens * after.budget.outputUsdPerMillionTokens;
    assert.equal(heldAfter / heldBefore, expectation.heldRatio, modelId);
  }
});
