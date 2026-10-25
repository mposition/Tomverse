import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_TASK_CATALOG_CAPS,
  deriveAmuxV4TaskAutoCatalog,
} from "../lib/amux/v4TaskCostAutoCatalogCore.ts";
import {
  calculateV4TaskCeilingFromCatalog,
  inspectV4TaskCostCatalog,
  inspectV52TaskCatalogGrades,
} from "../lib/amux/v4TaskCostCatalogCore.ts";

const NOW = "2026-10-25T01:02:03.000Z";
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
const priceFor = (modelId, inputTokens) => {
  asked.push([modelId, inputTokens]);
  return flat[modelId] ?? null;
};
const derive = (overrides = {}) => deriveAmuxV4TaskAutoCatalog({ workers, priceFor, ...overrides });
const ceiling = (catalog, role, grade, asOfIso = NOW) =>
  calculateV4TaskCeilingFromCatalog({ rawCatalog: catalog, role, grade, asOfIso });

test("the derived catalog passes the catalog and grade checks", () => {
  const result = derive();
  assert.equal(result.ok, true);
  assert.equal(inspectV4TaskCostCatalog(result.catalog).ok, true);
  const ceilings = new Map(workers.map((worker) => [worker.workerName, worker.roleCeiling]));
  assert.deepEqual(inspectV52TaskCatalogGrades(result.catalog, ceilings), { ok: true });
  assert.deepEqual(result.catalog.routes.map((route) =>
    [route.workerName, route.grades, route.roles]), [
    ["claude-chore", ["routine"], ["investigate"]],
    ["claude-contract", ["frontier"], ["design", "implement", "investigate"]],
    ["claude-impl", ["advanced"], ["implement", "investigate"]]]);
  assert.match(result.catalogId, /^registry:[a-f0-9]{32}$/);
  assert.equal(result.catalogId, `registry:${result.catalogDigest.slice(0, 32)}`);
});

test("only the Task roles a worker's profile runs get a ceiling", () => {
  const { catalog } = derive();
  assert.equal(ceiling(catalog, "implement", "advanced").ok, true);
  assert.equal(ceiling(catalog, "investigate", "routine").ok, true);
  for (const [role, grade] of [["test", "advanced"], ["implement", "routine"],
    ["review", "advanced"], ["verify", "frontier"]]) {
    assert.equal(ceiling(catalog, role, grade).ok, false, `${role}/${grade} has no worker`);
  }
});

test("each price is asked for at the input cap of the worker's grade", () => {
  asked.length = 0;
  derive();
  assert.deepEqual(asked.sort(), [["claude-haiku-4-5", 300_000],
    ["claude-opus-4-8", 1_000_000], ["claude-sonnet-5", 600_000]]);
});

test("prices round up to whole micro-USD; cache writes and tools are capped at zero", () => {
  const { catalog } = derive({ workers: [workers[0]], priceFor: () => ({
    inputUsdPerMillionTokens: 0.0000015, outputUsdPerMillionTokens: 1,
    cachedInputPriceMultiplier: 0.1 }) });
  const [route] = catalog.routes;
  assert.equal(route.uncachedInputMicroUsdPerMillion, 2);
  assert.equal(route.outputMicroUsdPerMillion, 1_000_000);
  assert.equal(route.cacheReadMicroUsdPerMillion, 1, "cached input uses the multiplier");
  assert.equal(route.cacheWriteMicroUsdPerMillion, 0);
  assert.equal(route.toolCostCapMicroUsdPerAttempt, 0);
  assert.equal(route.pricingSource, "model-registry:claude-haiku-4-5");
});

test("the ceiling is the grade caps times the dearest route at the grade", () => {
  const { catalog } = derive();
  // frontier: 1M input x $5 + 128k output x $25, three attempts.
  assert.equal(ceiling(catalog, "design", "frontier").receipt.ceilingMicroUsd,
    String(3 * (5_000_000 + 3_200_000)));
  assert.deepEqual(AMUX_TASK_CATALOG_CAPS.frontier,
    { inputTokens: 1_000_000, outputTokens: 128_000, maxAttempts: 3 });
});

test("prices never expire on their own: the catalog is valid at any time", () => {
  const { catalog } = derive();
  for (const asOf of ["2026-10-25T00:00:00.000Z", "2030-06-01T00:00:00.000Z"]) {
    assert.equal(ceiling(catalog, "implement", "advanced", asOf).ok, true, asOf);
  }
});

test("a worker without a price, a role ceiling or a Task role is left out", () => {
  const result = derive({ workers: [...workers,
    { workerName: "claude-new", modelId: "claude-unknown", roles: ["investigate"], roleCeiling: "chore" },
    { workerName: "claude-odd", modelId: "claude-sonnet-5", roles: ["implement"], roleCeiling: null },
    { workerName: "claude-reviewer", modelId: "claude-sonnet-5", roles: ["review"], roleCeiling: "contract" }] });
  assert.equal(result.catalog.routes.length, 3);
  assert.equal(result.catalogDigest, derive().catalogDigest,
    "a worker that cannot be priced does not change the catalog");
});

test("no priced worker, or a zero price, is a hold rather than a free route", () => {
  assert.deepEqual(derive({ workers: [] }), { ok: false, code: "no_priced_worker" });
  assert.deepEqual(derive({ workers: [workers[0]], priceFor: () => ({
    ...flat["claude-haiku-4-5"], outputUsdPerMillionTokens: 0 }) }),
  { ok: false, code: "no_priced_worker" });
});

test("the same registries give the same digest; a real change gives a new one", () => {
  const first = derive();
  assert.equal(derive().catalogDigest, first.catalogDigest, "no clock, no nonce");
  const repriced = derive({ priceFor: (modelId) => modelId === "claude-sonnet-5"
    ? { ...flat[modelId], inputUsdPerMillionTokens: 2.9 } : flat[modelId] });
  assert.notEqual(repriced.catalogDigest, first.catalogDigest);
  assert.notEqual(repriced.catalogId, first.catalogId);
  const recapped = derive({ caps: { ...AMUX_TASK_CATALOG_CAPS,
    routine: { ...AMUX_TASK_CATALOG_CAPS.routine, outputTokens: 40_000 } } });
  assert.notEqual(recapped.catalogDigest, first.catalogDigest);
  assert.deepEqual(repriced.catalog.routes.map((route) => route.routePolicyDigest),
    first.catalog.routes.map((route) => route.routePolicyDigest),
    "a price change never asks a Task to reconfirm its route");
});
