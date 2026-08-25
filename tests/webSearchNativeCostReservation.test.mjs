import assert from "node:assert/strict";
import test from "node:test";

import {
  missingAuthorizationIsADefect,
  recordSearchQueryCeilingBreach,
  reserveNativeSearchCost,
  resetSearchQueryCeilingBreaches,
  settledNativeSearchCost,
} from "../lib/webSearchNativeCostReservation.ts";
import {
  getWebSearchCapability,
  nativeSearchIsDispatchable,
  openAiNativeSearchToolCallCeiling,
  WEB_SEARCH_CAPABILITIES,
} from "../lib/webSearchCapability.ts";
import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";
import { getNativeSearchCostMicroUsdPerQuery } from "../lib/modelPricing.ts";
import { getModel, PUBLIC_MODELS } from "../lib/models.ts";

// A native search is billed per query on top of tokens. Reserving the worst
// case only works if there is a worst case, and these are about refusing to
// pretend there is one when the request cannot impose it.

const modelFor = (id) => getModel(id);

test("Anthropic reserves its enforced ceiling, because the request sends it", () => {
  const model = modelFor("claude-sonnet-5");
  const capability = getWebSearchCapability(model.id);
  assert.equal(capability.hasAdditionalCost, true);
  const reserved = reserveNativeSearchCost({
    model,
    capability,
    nativeSearchEnabled: true,
  });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.maxQueries, 5, "the same 5 the request's maxUses sends");
  assert.equal(
    reserved.reservedCostMicroUsd,
    reserved.costPerQueryMicroUsd * 5
  );
});

test("a paid search the request cannot bound is refused, not estimated", () => {
  // The tempting move is to reserve a typical query count. That is a
  // reservation which is right when it does not matter and wrong when it does.
  // Google's Search grounding takes no cap on the tool and none on the
  // request, so it is still the shape this refusal exists for.
  for (const id of ["gemini-3-1-pro", "gemini-3-6-flash", "gemini-2-5-flash"]) {
    const model = modelFor(id);
    if (!model) continue;
    const capability = getWebSearchCapability(model.id);
    assert.equal(capability.hasAdditionalCost, true, id);
    const reserved = reserveNativeSearchCost({
      model,
      capability,
      nativeSearchEnabled: true,
    });
    assert.equal(reserved.ok, false, id);
    assert.equal(reserved.ok === false && reserved.reason, "unbounded_search_queries");
    assert.equal(
      nativeSearchIsDispatchable(capability),
      false,
      `${id}: nothing may offer a search the reservation would refuse`
    );
  }
});

test("every enabled OpenAI native-search model reserves its exact ceiling", () => {
  // The defect this fixes: `gpt-5-6-luna` is a registered OpenAI native-search
  // model, and every one of them refused at dispatch because the capability
  // declared no ceiling. OpenAI's Responses API does take one --
  // `max_tool_calls` -- so the whole family is bounded, and the reservation is
  // that ceiling times the per-query rate rather than a guess.
  const openAiSearchModels = PUBLIC_MODELS.filter(
    (model) => getWebSearchCapability(model.id).provider === "openai"
  );
  assert.ok(
    openAiSearchModels.some((model) => model.id === "gpt-5-6-luna"),
    "the default model is one of them, and is why this test exists"
  );
  const perQuery = getNativeSearchCostMicroUsdPerQuery("openai");
  assert.ok(perQuery > 0);

  for (const model of openAiSearchModels) {
    const capability = getWebSearchCapability(model.id);
    assert.equal(nativeSearchIsDispatchable(capability), true, model.id);
    const reserved = reserveNativeSearchCost({
      model,
      capability,
      nativeSearchEnabled: true,
    });
    assert.equal(reserved.ok, true, model.id);
    assert.equal(reserved.maxQueries, 5, model.id);
    assert.equal(reserved.costPerQueryMicroUsd, perQuery, model.id);
    assert.equal(
      reserved.reservedCostMicroUsd,
      perQuery * 5,
      `${model.id}: ceiling times rate, not an observed average`
    );
  }
});

test("the ceiling the request enforces is the ceiling the reservation is sized on", () => {
  // The two must not be able to drift, which is why neither reads a literal:
  // both read `maxBillableSearchQueriesPerRequest` off the same capability. A
  // second copy of the number in either place fails here.
  for (const model of PUBLIC_MODELS) {
    const capability = getWebSearchCapability(model.id);
    if (capability.provider !== "openai") continue;
    const reserved = reserveNativeSearchCost({
      model,
      capability,
      nativeSearchEnabled: true,
    });
    assert.equal(reserved.ok, true, model.id);
    const settings = getModelGenerationSettings(model, {
      openAiMaxToolCalls: openAiNativeSearchToolCallCeiling({
        capability,
        nativeSearchEnabled: true,
      }),
    });
    assert.equal(
      settings.providerOptions?.openai?.maxToolCalls,
      reserved.maxQueries,
      `${model.id}: the request may spend exactly what was authorized`
    );
  }
});

test("no capability in the register declares a ceiling its provider cannot send", () => {
  // A ceiling is only a ceiling if a request carries it. Anthropic sends
  // `maxUses` on the tool, OpenAI sends `max_tool_calls` on the request, and
  // no other provider has a parameter to send -- so declaring one for a third
  // provider would be a reservation sized on a number nothing enforces.
  const providersThatCanEnforceACeiling = new Set(["openai", "anthropic"]);
  for (const [modelId, capability] of Object.entries(WEB_SEARCH_CAPABILITIES)) {
    if (capability.maxBillableSearchQueriesPerRequest === undefined) continue;
    assert.ok(
      providersThatCanEnforceACeiling.has(capability.provider ?? ""),
      `${modelId}: ${capability.provider} has no way to impose this ceiling`
    );
  }
});

test("a turn that is not searching reserves nothing", () => {
  const model = modelFor("claude-sonnet-5");
  const reserved = reserveNativeSearchCost({
    model,
    capability: getWebSearchCapability(model.id),
    nativeSearchEnabled: false,
  });
  assert.deepEqual(reserved, {
    ok: true,
    reservedCostMicroUsd: 0,
    costPerQueryMicroUsd: 0,
    maxQueries: 0,
  });
});

test("a search model's search is inside its response cost, so nothing is reserved", () => {
  // Perplexity reports one cost for the whole call; there is no separate
  // per-query charge to authorize.
  const capability = {
    support: "search-model",
    canForceExecution: true,
    returnsCitations: true,
    hasAdditionalCost: false,
  };
  const reserved = reserveNativeSearchCost({
    model: modelFor("claude-sonnet-5"),
    capability,
    nativeSearchEnabled: true,
  });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.reservedCostMicroUsd, 0);
});

test("settlement charges what ran, and says when it exceeded what was allowed", () => {
  const within = settledNativeSearchCost({
    provider: "anthropic",
    queryCount: 3,
    costPerQueryMicroUsd: 10_000,
    maxQueries: 5,
  });
  assert.deepEqual(within, { costMicroUsd: 30_000, breachedCeiling: false });

  // Not clamped to the ceiling. The provider bills for what it did, and a
  // ledger that recorded the authorized figure would be accurate about the
  // authorization and wrong about the money.
  const over = settledNativeSearchCost({
    provider: "anthropic",
    queryCount: 9,
    costPerQueryMicroUsd: 10_000,
    maxQueries: 5,
  });
  assert.deepEqual(over, { costMicroUsd: 90_000, breachedCeiling: true });
});

test("a breached ceiling stops the capability dispatching", () => {
  resetSearchQueryCeilingBreaches();
  const model = modelFor("claude-sonnet-5");
  const capability = getWebSearchCapability(model.id);
  assert.equal(
    reserveNativeSearchCost({ model, capability, nativeSearchEnabled: true }).ok,
    true
  );

  recordSearchQueryCeilingBreach("anthropic");
  const after = reserveNativeSearchCost({
    model,
    capability,
    nativeSearchEnabled: true,
  });
  assert.equal(after.ok, false);
  assert.equal(
    after.ok === false && after.reason,
    "search_query_ceiling_breached",
    "a ceiling that did not hold cannot size the next reservation"
  );
  resetSearchQueryCeilingBreaches();
});

test("no search still reserves nothing after a breach", () => {
  recordSearchQueryCeilingBreach("anthropic");
  const model = modelFor("claude-sonnet-5");
  const reserved = reserveNativeSearchCost({
    model,
    capability: getWebSearchCapability(model.id),
    nativeSearchEnabled: false,
  });
  assert.equal(reserved.ok, true, "the latch is about searching, not about the model");
  resetSearchQueryCeilingBreaches();
});

test("a missing authorization is a defect only after the cutover", () => {
  const before = new Date("2026-01-01T00:00:00.000Z");
  const after = new Date("2026-12-01T00:00:00.000Z");
  // Unset: the two cannot be told apart, and the lenient answer is the honest
  // one. Paging about every legacy turn on a deployment that never set the
  // variable would be an alarm nobody can act on.
  delete process.env.NATIVE_SEARCH_AUTHORIZATION_CUTOVER_AT;
  assert.equal(missingAuthorizationIsADefect(after), false);

  process.env.NATIVE_SEARCH_AUTHORIZATION_CUTOVER_AT =
    "2026-06-01T00:00:00.000Z";
  try {
    assert.equal(missingAuthorizationIsADefect(before), false, "dispatched under the older contract");
    assert.equal(missingAuthorizationIsADefect(after), true, "a writer stopped filling it");
  } finally {
    delete process.env.NATIVE_SEARCH_AUTHORIZATION_CUTOVER_AT;
  }
});

test("an unparseable cutover is treated as unset rather than as now", () => {
  process.env.NATIVE_SEARCH_AUTHORIZATION_CUTOVER_AT = "not a date";
  try {
    assert.equal(missingAuthorizationIsADefect(new Date()), false);
  } finally {
    delete process.env.NATIVE_SEARCH_AUTHORIZATION_CUTOVER_AT;
  }
});
