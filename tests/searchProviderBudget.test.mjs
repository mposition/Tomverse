import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVELOPMENT_SEARCH_PROVIDER_BUDGET_MICRO_USD,
  resolveActiveSearchProviderBudgets,
  resolveSearchProviderBudget,
  searchProviderBucketKey,
  searchProviderBudgetEnvName,
  searchProviderBudgetFloorMicroUsd,
  SEARCH_PROVIDER_BUDGET_PERIODS,
  worstSearchCostPerModelTurnMicroUsd,
} from "../lib/searchProviderBudget.ts";
import {
  getSearchProviderBudgetReadiness,
  requiredWebSearchBackends,
} from "../lib/searchProviderBudgetReadiness.ts";
import {
  listConfiguredWebSearchBackends,
  resolveWebSearchBackendReadiness,
  webSearchFakeBackendEnabled,
} from "../lib/webSearchBackendRuntime.ts";
import { getSearchBackendPriceProfile } from "../lib/webSearchBackendPricing.ts";

const DAY = searchProviderBudgetEnvName("brave", "day");
const MONTH = searchProviderBudgetEnvName("brave", "month");

/** A production-shaped environment with everything the feature needs. */
const productionEnv = (overrides = {}) => ({
  NODE_ENV: "production",
  BRAVE_SEARCH_API_KEY: "key",
  [DAY]: "60000000",
  [MONTH]: "600000000",
  ...overrides,
});

test("the Brave rate is its own price, never the Google grounding rate", () => {
  const profile = getSearchBackendPriceProfile("brave");
  // US$5.00 per 1,000 requests. 14,000 here would be Google's Gemini grounding
  // list rate, which is a different vendor's price for a different product.
  assert.equal(profile.costMicroUsdPerRequest, 5_000);
  assert.ok(profile.priceSource.includes("brave.com"));
  assert.ok(profile.effectiveDate);
  assert.ok(profile.pricingVersion);
  // Five requests per model per turn.
  assert.equal(worstSearchCostPerModelTurnMicroUsd("brave"), 25_000);
});

test("the floor is derived from what one Max account may legitimately spend", () => {
  // 10,000 monthly credits / 8 credits per searching model-turn = 1,250 turns,
  // times the 25,000 micro-USD worst case, times 1.25 headroom.
  assert.equal(searchProviderBudgetFloorMicroUsd("brave"), 39_062_500);
});

test("a budget below the floor is raised to it and reported, never silently applied", () => {
  const resolved = resolveSearchProviderBudget(
    "brave",
    productionEnv({ [DAY]: "1000", [MONTH]: "2000" })
  );
  const floor = searchProviderBudgetFloorMicroUsd("brave");
  assert.equal(resolved.limits.day, floor);
  assert.equal(resolved.limits.month, floor);
  assert.equal(resolved.clamped.length, 2);
  assert.equal(resolved.clamped[0].configuredMicroUsd, 1000);
  assert.equal(resolved.clamped[0].effectiveMicroUsd, floor);
});

test("production names its budget: an unset one is unusable, not defaulted", () => {
  const resolved = resolveSearchProviderBudget(
    "brave",
    productionEnv({ [DAY]: undefined, [MONTH]: undefined })
  );
  assert.equal(resolved.limits, null);
  assert.equal(resolved.source, "unconfigured");
  assert.deepEqual(
    resolved.problems.map((problem) => problem.reason),
    ["missing_in_production", "missing_in_production"]
  );
});

test("half a configuration is refused rather than half applied", () => {
  const resolved = resolveSearchProviderBudget(
    "brave",
    productionEnv({ [MONTH]: undefined })
  );
  assert.equal(resolved.limits, null);
  assert.equal(resolved.problems[0].reason, "partial_configuration");
});

test("a non-integer budget is refused rather than coerced", () => {
  for (const value of ["0", "-1", "abc", "1.5"]) {
    const resolved = resolveSearchProviderBudget(
      "brave",
      productionEnv({ [DAY]: value })
    );
    assert.equal(resolved.limits, null, value);
    assert.equal(resolved.problems[0].reason, "not_a_positive_integer", value);
  }
});

test("development gets a default, never below the floor production is held to", () => {
  const resolved = resolveSearchProviderBudget("brave", {
    NODE_ENV: "development",
  });
  assert.equal(resolved.source, "development_default");
  const floor = searchProviderBudgetFloorMicroUsd("brave");
  assert.ok(resolved.limits.day >= floor);
  assert.ok(resolved.limits.month >= floor);
  assert.ok(
    resolved.limits.month >=
      Math.max(floor, DEVELOPMENT_SEARCH_PROVIDER_BUDGET_MICRO_USD.month)
  );
});

test("a month that is not above the day surfaces without blocking", () => {
  const floor = searchProviderBudgetFloorMicroUsd("brave");
  const resolved = resolveSearchProviderBudget(
    "brave",
    productionEnv({ [DAY]: String(floor), [MONTH]: String(floor) })
  );
  assert.ok(resolved.limits, "a legal-but-odd budget still resolves");
  assert.equal(resolved.advisories[0].code, "month_not_above_day");
});

test("only backends this deployment could actually call are required to have one", () => {
  // A backend nobody holds a credential for cannot receive a request, so
  // demanding its budget would block a deploy over spend that cannot happen.
  assert.deepEqual(resolveActiveSearchProviderBudgets([], productionEnv()), []);
  assert.equal(
    resolveActiveSearchProviderBudgets(["brave"], productionEnv()).length,
    1
  );
});

test("the bucket and periods are named apart from the chat provider budget", () => {
  assert.equal(searchProviderBucketKey("brave"), "search-provider:brave");
  assert.deepEqual(SEARCH_PROVIDER_BUDGET_PERIODS, [
    "search-cost-day",
    "search-cost-month",
  ]);
  // Not `provider-cost-day`: settlement keys off these strings, and a search
  // hold that shared a period name would be settled to a model provider's cost.
  for (const period of SEARCH_PROVIDER_BUDGET_PERIODS) {
    assert.ok(!period.startsWith("provider-cost-"));
  }
});

// ---------------------------------------------------------------------------
// Runtime readiness. The register is compiled in; the credential is not.
// ---------------------------------------------------------------------------

test("the enabled catalogue requires the Brave backend", () => {
  // The Google models are application-managed, so a production deployment that
  // ships them must hold a credential for their backend.
  assert.deepEqual(requiredWebSearchBackends(), ["brave"]);
});

test("readiness fails in production with no credential for a required backend", () => {
  const readiness = getSearchProviderBudgetReadiness(
    productionEnv({ BRAVE_SEARCH_API_KEY: undefined })
  );
  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.problems.map((problem) => problem.code),
    ["no_backend_configured"]
  );
});

test("readiness fails in production with a credential and no budget", () => {
  const readiness = getSearchProviderBudgetReadiness(
    productionEnv({ [DAY]: undefined, [MONTH]: undefined })
  );
  assert.equal(readiness.ready, false);
  assert.ok(
    readiness.problems.some((problem) => problem.code === "budget_unusable")
  );
});

test("readiness fails in production if the deterministic fake is even requested", () => {
  const readiness = getSearchProviderBudgetReadiness(
    productionEnv({ WEB_SEARCH_FAKE_BACKEND: "1" })
  );
  assert.equal(readiness.ready, false);
  assert.ok(
    readiness.problems.some(
      (problem) => problem.code === "fake_backend_in_production"
    )
  );
  // And it is refused whatever the variable says, so a deployment that set it
  // by accident serves the web rather than a fixture.
  assert.equal(
    webSearchFakeBackendEnabled(productionEnv({ WEB_SEARCH_FAKE_BACKEND: "1" })),
    false
  );
});

test("a fully configured production deployment is ready", () => {
  const readiness = getSearchProviderBudgetReadiness(productionEnv());
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.configuredBackends, ["brave"]);
});

test("development with no credential is ready, and offers no search", () => {
  // Failing here would make a search API key a precondition for running the
  // application at all. Everything downstream is still correct: no backend is
  // reachable, so the Google models are offered as unable to search.
  const env = { NODE_ENV: "development" };
  const readiness = getSearchProviderBudgetReadiness(env);
  assert.equal(readiness.ready, true);
  assert.deepEqual(listConfiguredWebSearchBackends(env), []);
  assert.deepEqual(resolveWebSearchBackendReadiness(env), {});
});

test("the fake reports every backend as reachable outside production", () => {
  const env = { NODE_ENV: "test", WEB_SEARCH_FAKE_BACKEND: "1" };
  assert.equal(webSearchFakeBackendEnabled(env), true);
  assert.deepEqual(listConfiguredWebSearchBackends(env), ["brave"]);
  assert.deepEqual(resolveWebSearchBackendReadiness(env), { brave: true });
});

test("a credential with an unreadable budget is not reachable", () => {
  // Dispatching against a budget nobody can read means the operational cap that
  // bounds this vendor's invoice is not being enforced. The honest thing to
  // offer is a model that does not search.
  const env = productionEnv({ [DAY]: "not-a-number" });
  assert.deepEqual(resolveWebSearchBackendReadiness(env), {});
});
