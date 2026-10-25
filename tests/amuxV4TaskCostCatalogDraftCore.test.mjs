import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_TASK_CATALOG_DEFAULT_CAPS,
  amuxTaskCatalogCapsOf,
  amuxTaskCatalogVersion,
  draftAmuxV4TaskCostCatalog,
} from "../lib/amux/v4TaskCostCatalogDraftCore.ts";
import {
  calculateV4TaskCeilingFromCatalog,
  inspectV4TaskCostCatalog,
  inspectV52TaskCatalogGrades,
} from "../lib/amux/v4TaskCostCatalogCore.ts";

const NOW = "2026-10-25T01:02:03.000Z";
const VERSION = amuxTaskCatalogVersion(NOW, "0a1b2c3d");
const workers = [
  { workerName: "claude-chore", modelId: "claude-haiku-4-5", roles: ["investigate"],
    roleCeiling: "chore" },
  { workerName: "claude-impl", modelId: "claude-sonnet-5",
    roles: ["implement", "investigate", "review"], roleCeiling: "implementation" },
  { workerName: "claude-contract", modelId: "claude-opus-4-8",
    roles: ["design", "implement", "investigate"], roleCeiling: "contract" },
];
const flat = {
  "claude-haiku-4-5": { inputUsdPerMillionTokens: 0.5, outputUsdPerMillionTokens: 1,
    cachedInputPriceMultiplier: 0.1 },
  "claude-sonnet-5": { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 12,
    cachedInputPriceMultiplier: 0.1 },
  "claude-opus-4-8": { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25,
    cachedInputPriceMultiplier: 1 },
};
const asked = [];
const priceFor = (modelId, inputTokens) => { asked.push([modelId, inputTokens]); return flat[modelId] ?? null; };
const draft = (overrides = {}) => draftAmuxV4TaskCostCatalog({ workers, priceFor,
  caps: AMUX_TASK_CATALOG_DEFAULT_CAPS, nowIso: NOW, catalogVersion: VERSION, ...overrides });

test("a drafted catalog is one the approval checks accept", () => {
  const result = draft();
  assert.equal(result.ok, true);
  assert.equal(inspectV4TaskCostCatalog(result.catalog).ok, true);
  const ceilings = new Map(workers.map((worker) => [worker.workerName, worker.roleCeiling]));
  assert.deepEqual(inspectV52TaskCatalogGrades(result.catalog, ceilings), { ok: true });
  assert.deepEqual(result.routes.map((route) => [route.workerName, route.grade, route.roles]), [
    ["claude-chore", "routine", ["investigate"]],
    ["claude-contract", "frontier", ["design", "implement", "investigate"]],
    ["claude-impl", "advanced", ["implement", "investigate"]]]);
  assert.deepEqual(result.skipped, []);
});

test("only the Task roles a worker's profile runs get a ceiling", () => {
  const result = draft();
  const ceiling = (role, grade) => calculateV4TaskCeilingFromCatalog({
    rawCatalog: result.catalog, role, grade, asOfIso: NOW });
  assert.equal(ceiling("implement", "advanced").ok, true);
  assert.equal(ceiling("investigate", "routine").ok, true);
  for (const [role, grade] of [["test", "advanced"], ["implement", "routine"],
    ["review", "advanced"], ["verify", "frontier"]]) {
    assert.equal(ceiling(role, grade).ok, false, `${role}/${grade} has no worker`);
  }
});

test("each price is asked for at the input cap of the worker's grade", () => {
  asked.length = 0;
  draft();
  assert.deepEqual(asked.sort(), [["claude-haiku-4-5", 300_000],
    ["claude-opus-4-8", 1_000_000], ["claude-sonnet-5", 600_000]]);
});

test("prices are rounded up to whole micro-USD and cache writes are capped at zero", () => {
  const result = draft({ workers: [workers[0]], priceFor: () => ({
    inputUsdPerMillionTokens: 0.0000015, outputUsdPerMillionTokens: 1,
    cachedInputPriceMultiplier: 0.1 }) });
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

test("a worker without a price, a role ceiling or a Task role is listed, not priced", () => {
  const result = draft({ workers: [...workers,
    { workerName: "claude-new", modelId: "claude-unknown", roles: ["investigate"], roleCeiling: "chore" },
    { workerName: "claude-odd", modelId: "claude-sonnet-5", roles: ["implement"], roleCeiling: null },
    { workerName: "claude-reviewer", modelId: "claude-sonnet-5", roles: ["review"], roleCeiling: "contract" }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, [
    { workerName: "claude-new", modelId: "claude-unknown", reason: "price_missing" },
    { workerName: "claude-odd", modelId: "claude-sonnet-5", reason: "grade_unknown" },
    { workerName: "claude-reviewer", modelId: "claude-sonnet-5", reason: "roles_missing" }]);
  assert.equal(result.routes.length, 3);
});

test("a zero or missing price never becomes a free route", () => {
  const result = draft({ workers: [workers[0]], priceFor: () => ({
    ...flat["claude-haiku-4-5"], outputUsdPerMillionTokens: 0 }) });
  assert.deepEqual(result, { ok: false, code: "no_priced_worker",
    skipped: [{ workerName: "claude-chore", modelId: "claude-haiku-4-5", reason: "price_missing" }] });
});

test("caps outside the allowed range, or a version not made here, are refused", () => {
  for (const bad of [0, -1, 1.5, 10_000_001, Number.NaN]) {
    const result = draft({ caps: { ...AMUX_TASK_CATALOG_DEFAULT_CAPS,
      advanced: { ...AMUX_TASK_CATALOG_DEFAULT_CAPS.advanced, inputTokens: bad } } });
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.code, "caps_invalid");
  }
  assert.equal(draft({ caps: { ...AMUX_TASK_CATALOG_DEFAULT_CAPS,
    frontier: { ...AMUX_TASK_CATALOG_DEFAULT_CAPS.frontier, maxAttempts: 11 } } }).ok, false);
  assert.equal(draft({ catalogVersion: "catalog-v1" }).ok, false);
});

test("two drafts in the same second never share a version", () => {
  assert.notEqual(amuxTaskCatalogVersion(NOW, "00000001"), amuxTaskCatalogVersion(NOW, "00000002"));
  assert.notEqual(amuxTaskCatalogVersion(NOW, "00000001"),
    amuxTaskCatalogVersion("2026-10-25T01:02:03.001Z", "00000001"));
});

test("the same inputs redraft the same digest, which is what approval checks", () => {
  const first = draft();
  const again = draft();
  assert.equal(again.catalogDigest, first.catalogDigest);
  assert.equal(again.evidenceDigest, first.evidenceDigest);
  assert.deepEqual(amuxTaskCatalogCapsOf(first.catalog), AMUX_TASK_CATALOG_DEFAULT_CAPS);
  const repriced = draft({ priceFor: (modelId) => modelId === "claude-sonnet-5"
    ? { ...flat[modelId], inputUsdPerMillionTokens: 2.9 } : flat[modelId] });
  assert.notEqual(repriced.catalogDigest, first.catalogDigest);
  assert.notEqual(repriced.evidenceDigest, first.evidenceDigest);
});

test("drafting later keeps each route's policy digest, so Tasks need no reconfirm", () => {
  const first = draft();
  const later = draft({ nowIso: "2026-11-30T00:00:00.000Z",
    catalogVersion: amuxTaskCatalogVersion("2026-11-30T00:00:00.000Z", "ffffffff") });
  assert.deepEqual(first.catalog.routes.map((route) => route.routePolicyDigest),
    later.catalog.routes.map((route) => route.routePolicyDigest));
});

test("caps are read back only when every role uses the same caps per grade", () => {
  const { catalog } = draft();
  const uneven = { ...catalog, gradeRules: catalog.gradeRules.map((rule, index) =>
    index === 0 ? { ...rule, caps: { ...rule.caps, outputTokens: 1 } } : rule) };
  assert.equal(amuxTaskCatalogCapsOf(uneven), null);
});
