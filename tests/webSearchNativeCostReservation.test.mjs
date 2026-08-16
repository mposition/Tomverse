import assert from "node:assert/strict";
import test from "node:test";

import {
  recordSearchQueryCeilingBreach,
  reserveNativeSearchCost,
  resetSearchQueryCeilingBreaches,
  settledNativeSearchCost,
} from "../lib/webSearchNativeCostReservation.ts";
import { getWebSearchCapability } from "../lib/webSearchCapability.ts";
import { getModel } from "../lib/models.ts";

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
  for (const id of ["gpt-5-6-luna", "gemini-3-1-pro"]) {
    const model = modelFor(id);
    if (!model) continue;
    const capability = getWebSearchCapability(model.id);
    if (!capability.hasAdditionalCost) continue;
    const reserved = reserveNativeSearchCost({
      model,
      capability,
      nativeSearchEnabled: true,
    });
    assert.equal(reserved.ok, false, id);
    assert.equal(reserved.ok === false && reserved.reason, "unbounded_search_queries");
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
