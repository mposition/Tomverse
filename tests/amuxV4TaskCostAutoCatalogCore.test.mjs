import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_TASK_CATALOG_CAPS,
  amuxTaskRoutePrice,
  deriveAmuxV4TaskAutoCatalog,
  parseAmuxTaskRoutePrice,
} from "../lib/amux/v4TaskCostAutoCatalogCore.ts";
import {
  calculateV4TaskCeilingFromCatalog,
  inspectV4TaskCostCatalog,
  inspectV52TaskCatalogGrades,
} from "../lib/amux/v4TaskCostCatalogCore.ts";
import { deriveAmuxWorkerCatalog } from "../lib/amux/workerDerivedCatalogCore.ts";
import { amuxWorkerProviderClassOf } from "../lib/amux/workerRegistryCore.ts";

const NOW = "2026-10-25T01:02:03.000Z";
const workers = [
  { workerName: "claude-chore", provider: "anthropic", modelId: "claude-haiku-4-5", roles: ["investigate"],
    roleCeiling: "chore" },
  { workerName: "claude-impl", provider: "anthropic", modelId: "claude-sonnet-5",
    roles: ["implement", "investigate", "review"], roleCeiling: "implementation" },
  { workerName: "claude-contract", provider: "anthropic", modelId: "claude-opus-4-8",
    roles: ["design", "implement", "investigate"], roleCeiling: "contract" },
];
// Verified five-minute write rates are 1.25x input.
const flat = {
  "claude-haiku-4-5": { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5,
    cachedInputPriceMultiplier: 0.1, cacheWriteUsdPerMillionTokens: 1.25 },
  "claude-sonnet-5": { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 12,
    cachedInputPriceMultiplier: 0.1, cacheWriteUsdPerMillionTokens: 3.75 },
  "claude-opus-4-8": { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25,
    cachedInputPriceMultiplier: 0.1, cacheWriteUsdPerMillionTokens: 6.25 },
};
const asked = [];
const priceFor = (modelId, inputTokens) => {
  asked.push([modelId, inputTokens]);
  return flat[modelId] ?? null;
};
const derive = (overrides = {}) => deriveAmuxV4TaskAutoCatalog({ workers, priceFor, ...overrides });
const ceiling = (catalog, role, grade, asOfIso = NOW) =>
  calculateV4TaskCeilingFromCatalog({ rawCatalog: catalog, role, grade, asOfIso });
const routeOf = (catalog, modelId) => catalog.routes.find((route) => route.modelId === modelId);

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
    ["claude-opus-4-8", 200_000], ["claude-sonnet-5", 300_000]]);
});

test("prices round up to whole micro-USD and tool cost is capped at zero", () => {
  const { catalog } = derive({ workers: [workers[0]], priceFor: () => ({
    inputUsdPerMillionTokens: 0.0000015, outputUsdPerMillionTokens: 1,
    cachedInputPriceMultiplier: 0.1, cacheWriteUsdPerMillionTokens: 0.0000025 }) });
  const [route] = catalog.routes;
  assert.equal(route.uncachedInputMicroUsdPerMillion, 2);
  assert.equal(route.outputMicroUsdPerMillion, 1_000_000);
  assert.equal(route.cacheReadMicroUsdPerMillion, 1, "cached input uses the multiplier");
  assert.equal(route.cacheWriteMicroUsdPerMillion, 3, "the verified five-minute rate");
  assert.equal(route.toolCostCapMicroUsdPerAttempt, 0);
  assert.equal(route.pricingSource, "model-registry:claude-haiku-4-5");
});

test("a cache write is priced at the verified five-minute rate the CLI is charged", () => {
  const { catalog } = derive();
  assert.equal(routeOf(catalog, "claude-sonnet-5").cacheWriteMicroUsdPerMillion, 3_750_000);
  assert.equal(routeOf(catalog, "claude-opus-4-8").cacheWriteMicroUsdPerMillion, 6_250_000);
});

test("a model with no verified cache-write rate is still priced, at Anthropic's 1.25x rule", () => {
  const result = derive({ workers: [workers[1]], priceFor: () => ({
    ...flat["claude-sonnet-5"], cacheWriteUsdPerMillionTokens: null }) });
  assert.equal(result.ok, true, "a model without a write rate never blocks registration");
  assert.equal(result.catalog.routes[0].cacheWriteMicroUsdPerMillion, 3_750_000);
});

test("the reservation covers a Claude-shaped run that uses every cap", () => {
  const { catalog } = derive();
  const caps = AMUX_TASK_CATALOG_CAPS.frontier;
  const route = routeOf(catalog, "claude-opus-4-8");
  const result = ceiling(catalog, "design", "frontier");
  assert.equal(result.ok, true);
  // Cache reads and writes are reported apart from input and settled at the
  // route rates; one attempt at every cap must fit its reservation.
  const fullAttempt = Math.ceil((caps.inputTokens * route.uncachedInputMicroUsdPerMillion +
    caps.cacheReadTokens * route.cacheReadMicroUsdPerMillion +
    caps.cacheWriteTokens * route.cacheWriteMicroUsdPerMillion +
    caps.outputTokens * route.outputMicroUsdPerMillion) / 1_000_000);
  const perAttempt = BigInt(result.receipt.routes[0].perAttemptMicroUsd);
  assert.ok(BigInt(fullAttempt) <= perAttempt, `${fullAttempt} <= ${perAttempt}`);
  assert.equal(BigInt(result.receipt.ceilingMicroUsd), perAttempt * BigInt(caps.maxAttempts));
});

test("live prices hold whenever the catalog is derived", () => {
  const { catalog } = derive();
  for (const asOf of ["2026-10-25T00:00:00.000Z", "2030-06-01T00:00:00.000Z"]) {
    assert.equal(ceiling(catalog, "implement", "advanced", asOf).ok, true, asOf);
  }
});

test("an assignment records exactly its route's prices, and only that shape reads back", () => {
  const { catalog } = derive();
  const price = amuxTaskRoutePrice(catalog, "v22:claude-impl");
  assert.deepEqual(price, { pricingVersion: catalog.pricingVersion,
    modelId: "claude-sonnet-5", uncachedInputMicroUsdPerMillion: 3_000_000,
    cacheReadMicroUsdPerMillion: 300_000, cacheWriteMicroUsdPerMillion: 3_750_000,
    outputMicroUsdPerMillion: 12_000_000 });
  assert.deepEqual(parseAmuxTaskRoutePrice(price), price);
  assert.equal(amuxTaskRoutePrice(catalog, "v22:nobody"), null);
  for (const bad of [null, [], { ...price, extra: 1 },
    { ...price, outputMicroUsdPerMillion: 0 }, { ...price, cacheReadMicroUsdPerMillion: -1 },
    { ...price, uncachedInputMicroUsdPerMillion: 1.5 }, { ...price, modelId: "a b" }]) {
    assert.equal(parseAmuxTaskRoutePrice(bad), null, JSON.stringify(bad));
  }
});

test("a worker without a price, a role ceiling or a Task role is left out", () => {
  const result = derive({ workers: [...workers,
    { workerName: "claude-new", provider: "anthropic", modelId: "claude-unknown", roles: ["investigate"], roleCeiling: "chore" },
    { workerName: "claude-odd", provider: "anthropic", modelId: "claude-sonnet-5", roles: ["implement"], roleCeiling: null },
    { workerName: "claude-reviewer", provider: "anthropic", modelId: "claude-sonnet-5", roles: ["review"], roleCeiling: "contract" }] });
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

test("the same prices give the same digest; a real change gives a new one", () => {
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

test("a dear model is priced, not left out: the reservation is the budget", () => {
  const dear = derive({ workers: [workers[2]], priceFor: () => ({
    inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 50,
    cachedInputPriceMultiplier: 0.1, cacheWriteUsdPerMillionTokens: 12.5 }) });
  assert.equal(dear.ok, true);
  assert.ok(BigInt(ceiling(dear.catalog, "design", "frontier").receipt.routes[0].perAttemptMicroUsd) >
    BigInt(5_000_000));
});

test("a chore worker's v22 implement profile prices routine implement Tasks (v52, 2026-10-27)", () => {
  // The registry and capability as the owner records them, through the
  // derived assignment catalog the approval service reads.
  const registration = (workerName, roleCeiling) => ({ workerName,
    providerClass: amuxWorkerProviderClassOf(workerName), roleCeiling,
    desiredState: "active", revision: 1 });
  const registrations = [registration("claude-chore", "chore"),
    registration("codex-chore", "chore")];
  const profile = (model) => ({ capability: { model: null, routingTags: ["chore"],
    toolCapabilities: [], v22: { model, roles: ["implement", "investigate"],
      tools: ["repo_read", "repo_write"] } } });
  const derived = deriveAmuxWorkerCatalog({ registrations,
    capabilities: new Map([["claude-chore", profile("claude-haiku-4-5")],
      ["codex-chore", profile("gpt-6-luna")]]),
    latches: new Map(), multiProvider: true });
  assert.deepEqual(derived.v22.map((entry) => [entry.worker_name, entry.routing_roles]), [
    ["claude-chore", ["implement", "investigate"]],
    ["codex-chore", ["implement", "investigate"]]]);
  const ceilings = new Map(registrations.map((entry) => [entry.workerName, entry.roleCeiling]));
  const result = deriveAmuxV4TaskAutoCatalog({ priceFor: (modelId) =>
    flat[modelId] ?? (modelId === "gpt-6-luna" ? flat["claude-haiku-4-5"] : null),
  workers: derived.v22.map((entry) => ({ workerName: entry.worker_name,
    provider: entry.provider, modelId: entry.model, roles: entry.routing_roles,
    roleCeiling: ceilings.get(entry.worker_name) ?? null })) });
  assert.equal(result.ok, true);
  assert.deepEqual(inspectV52TaskCatalogGrades(result.catalog, ceilings), { ok: true });
  assert.deepEqual(result.catalog.routes.map((route) => [route.workerName, route.grades]), [
    ["claude-chore", ["routine"]], ["codex-chore", ["routine"]]]);
  assert.equal(ceiling(result.catalog, "implement", "routine").ok, true);
  // Same-grade routing is unchanged: a chore worker never prices advanced work.
  assert.equal(ceiling(result.catalog, "implement", "advanced").ok, false);
});
