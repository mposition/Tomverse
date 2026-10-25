import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_TASK_CATALOG_DEFAULT_CAPS,
  AMUX_TASK_CATALOG_ROLES,
  draftAmuxV4TaskCostCatalog,
} from "../lib/amux/v4TaskCostCatalogDraftCore.ts";
import {
  calculateV4TaskCeilingFromCatalog,
  inspectV4TaskCostCatalog,
  inspectV52TaskCatalogGrades,
} from "../lib/amux/v4TaskCostCatalogCore.ts";

const NOW = "2026-10-25T01:02:03.000Z";
const workers = [
  { workerName: "claude-chore", modelId: "claude-haiku-4-5", roleCeiling: "chore" },
  { workerName: "claude-impl", modelId: "claude-sonnet-5", roleCeiling: "implementation" },
  { workerName: "claude-contract", modelId: "claude-opus-4-8", roleCeiling: "contract" },
];
const prices = [
  { modelId: "claude-haiku-4-5", inputUsdPerMillionTokens: 0.5,
    outputUsdPerMillionTokens: 1, cachedInputPriceMultiplier: 0.1 },
  { modelId: "claude-sonnet-5", inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 12, cachedInputPriceMultiplier: null },
  { modelId: "claude-opus-4-8", inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25, cachedInputPriceMultiplier: 1 },
];
const draft = (overrides = {}) => draftAmuxV4TaskCostCatalog({ workers, prices,
  caps: AMUX_TASK_CATALOG_DEFAULT_CAPS, nowIso: NOW, ...overrides });

test("a drafted catalog is one the approval checks accept", () => {
  const result = draft();
  assert.equal(result.ok, true);
  assert.equal(inspectV4TaskCostCatalog(result.catalog).ok, true);
  const ceilings = new Map(workers.map((worker) => [worker.workerName, worker.roleCeiling]));
  assert.deepEqual(inspectV52TaskCatalogGrades(result.catalog, ceilings), { ok: true });
  assert.deepEqual(result.routes.map((route) => [route.workerName, route.grade]), [
    ["claude-chore", "routine"], ["claude-contract", "frontier"], ["claude-impl", "advanced"]]);
  assert.deepEqual(result.skipped, []);
});

test("every Task role gets a ceiling at a grade that has a priced worker", () => {
  const result = draft();
  for (const role of AMUX_TASK_CATALOG_ROLES) {
    for (const grade of ["routine", "advanced", "frontier"]) {
      const cost = calculateV4TaskCeilingFromCatalog({ rawCatalog: result.catalog,
        role, grade, asOfIso: NOW });
      assert.equal(cost.ok, true, `${role}/${grade}`);
      assert.equal(cost.receipt.ceilingMicroUsd, result.maxCostMicroUsd[grade]);
    }
  }
  assert.equal(calculateV4TaskCeilingFromCatalog({ rawCatalog: result.catalog,
    role: "review", grade: "routine", asOfIso: NOW }).ok, false,
  "review is never a Task role");
});

test("prices come from the registry rate, rounded up to whole micro-USD", () => {
  const result = draft({ prices: [{ ...prices[0], inputUsdPerMillionTokens: 0.0000015 }],
    workers: [workers[0]] });
  const route = result.catalog.routes[0];
  assert.equal(route.uncachedInputMicroUsdPerMillion, 2);
  assert.equal(route.outputMicroUsdPerMillion, 1_000_000);
  assert.equal(route.cacheReadMicroUsdPerMillion, 1, "cached input uses the multiplier");
  assert.equal(route.cacheWriteMicroUsdPerMillion, 0);
  assert.equal(route.toolCostCapMicroUsdPerAttempt, 0);
  assert.equal(route.pricingSource, "model-registry:claude-haiku-4-5");
  assert.equal(route.pricingVerifiedAt, NOW);
  assert.equal(route.pricingExpiresAt, "2027-01-23T01:02:03.000Z");
  assert.equal(result.pricesExpireAt, route.pricingExpiresAt);
});

test("the maximum cost is caps times the dearest route at the grade", () => {
  const result = draft();
  // frontier: 1M input x $5 + 128k output x $25, three attempts.
  assert.equal(result.maxCostMicroUsd.frontier, String(3 * (5_000_000 + 3_200_000)));
});

test("a worker without a price or a role ceiling is listed, not priced", () => {
  const result = draft({ workers: [...workers,
    { workerName: "claude-new", modelId: "claude-unpriced", roleCeiling: "chore" },
    { workerName: "claude-odd", modelId: "claude-sonnet-5", roleCeiling: null }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, [
    { workerName: "claude-new", modelId: "claude-unpriced", reason: "price_missing" },
    { workerName: "claude-odd", modelId: "claude-sonnet-5", reason: "grade_unknown" }]);
  assert.equal(result.routes.length, 3);
});

test("a zero or missing registry price never becomes a free route", () => {
  const result = draft({ workers: [workers[0]], prices: [{ ...prices[0],
    outputUsdPerMillionTokens: 0 }] });
  assert.deepEqual(result, { ok: false, code: "no_priced_worker",
    skipped: [{ workerName: "claude-chore", modelId: "claude-haiku-4-5", reason: "price_missing" }] });
});

test("caps outside the allowed range are refused", () => {
  for (const bad of [0, -1, 1.5, 10_000_001, Number.NaN]) {
    const result = draft({ caps: { ...AMUX_TASK_CATALOG_DEFAULT_CAPS,
      advanced: { ...AMUX_TASK_CATALOG_DEFAULT_CAPS.advanced, inputTokens: bad } } });
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.code, "caps_invalid");
  }
  assert.equal(draft({ caps: { ...AMUX_TASK_CATALOG_DEFAULT_CAPS,
    frontier: { ...AMUX_TASK_CATALOG_DEFAULT_CAPS.frontier, maxAttempts: 11 } } }).ok, false);
});

test("drafting again later keeps each route's policy digest, so Tasks need no reconfirm", () => {
  const first = draft();
  const later = draft({ nowIso: "2026-11-30T00:00:00.000Z" });
  assert.deepEqual(first.catalog.routes.map((route) => route.routePolicyDigest),
    later.catalog.routes.map((route) => route.routePolicyDigest));
  assert.equal(first.evidenceDigest, later.evidenceDigest, "same prices, same evidence");
  assert.notEqual(first.catalog.catalogVersion, later.catalog.catalogVersion);
  const repriced = draft({ prices: [{ ...prices[0], inputUsdPerMillionTokens: 0.6 },
    prices[1], prices[2]] });
  assert.notEqual(repriced.evidenceDigest, first.evidenceDigest);
  assert.notEqual(repriced.catalog.pricingVersion, first.catalog.pricingVersion);
});
