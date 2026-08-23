import assert from "node:assert/strict";
import test from "node:test";

import { registryRowToModel } from "../lib/modelRegistry.ts";
import {
  staticModelRegistryReconciliationRows,
  staticModelRegistrySeedRows,
} from "../lib/modelRegistryShared.ts";
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
