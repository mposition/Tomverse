import assert from "node:assert/strict";
import test from "node:test";
import { amuxV22RecoveryAddedRouteConsented } from "../lib/amux/v22TaskRecoveryCore.ts";
import { calculateV4TaskCeilingFromCatalog } from "../lib/amux/v4TaskCostCatalogCore.ts";

const route = (routeId, workerName, overrides = {}) => ({ routeId, workerName,
  provider: "anthropic", modelId: "claude-opus-5-5", routePolicyDigest: "b".repeat(64),
  enabled: true, roles: ["investigate"], grades: ["small"], pricingSource: "approved-record",
  pricingVerifiedAt: "2026-10-13T00:00:00.000Z", pricingExpiresAt: "2026-10-20T00:00:00.000Z",
  uncachedInputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 1_000_000,
  cacheReadMicroUsdPerMillion: 0, cacheWriteMicroUsdPerMillion: 0,
  toolCostCapMicroUsdPerAttempt: 0, ...overrides });
const receipt = (routes, caps = {}) => {
  const result = calculateV4TaskCeilingFromCatalog({ rawCatalog: { schemaVersion: 1,
    catalogVersion: "catalog-1", pricingVersion: "price-1", gradeRulesVersion: "grade-1",
    gradeRules: [{ role: "investigate", grade: "small", caps: { uncachedInputTokens: 1000,
      outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, maxAttempts: 1, ...caps } }],
    routes }, role: "investigate", grade: "small", asOfIso: "2026-10-14T00:00:00.000Z" });
  assert.equal(result.ok, true);
  return result.receipt;
};
const chore = route("v22-chore-investigate", "claude-chore");
const contract = route("v22-contract-investigate", "claude-contract");

test("v48: the owner's consent covers only a route the catalog added after registration", () => {
  const registered = receipt([chore]);
  const current = receipt([chore, contract]);
  assert.equal(amuxV22RecoveryAddedRouteConsented(registered, current, contract.routeId), true);
  // Unchanged routes need no consent at all.
  assert.equal(amuxV22RecoveryAddedRouteConsented(current, current, contract.routeId), true);
});

test("v48: a changed existing route, raised bounds or ceiling, or a wrong selection still refuse", () => {
  const registered = receipt([chore]);
  const changed = receipt([route(chore.routeId, "claude-chore",
    { routePolicyDigest: "c".repeat(64) }), contract]);
  assert.equal(amuxV22RecoveryAddedRouteConsented(registered, changed, contract.routeId), false);
  const pricier = receipt([chore, route(contract.routeId, "claude-contract",
    { outputMicroUsdPerMillion: 9_000_000 })]);
  assert.equal(amuxV22RecoveryAddedRouteConsented(registered, pricier, contract.routeId), false);
  const wider = receipt([chore, contract], { outputTokens: 2000 });
  assert.equal(amuxV22RecoveryAddedRouteConsented(registered, wider, contract.routeId), false);
  const current = receipt([chore, contract]);
  assert.equal(amuxV22RecoveryAddedRouteConsented(registered, current, chore.routeId), false);
  assert.equal(amuxV22RecoveryAddedRouteConsented(registered, current, "not-listed"), false);
  assert.equal(amuxV22RecoveryAddedRouteConsented(null, current, contract.routeId), false);
  // Every registered route gone: nothing the owner approved is left to compare.
  assert.equal(amuxV22RecoveryAddedRouteConsented(registered, receipt([contract]),
    contract.routeId), false);
});
