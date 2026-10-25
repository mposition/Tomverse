import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

import { AMUX_TASK_ATTEMPT_BUDGET_MAX_MICROUSD, AMUX_TASK_CATALOG_CAPS } from
  "../../lib/amux/v4TaskCostAutoCatalogCore.ts";

// The Task cost catalog is derived from the registries (owner decision
// 2026-10-25): the worker registry's v22 workers, priced from Admin › Models
// the way Chat bills them.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const NOW = new Date("2026-10-25T00:00:00.000Z");

mock.module(mod("lib/amux/workerAssignmentCatalog.ts"), { namedExports: {
  readAmuxRegistryAndDerivedCatalog: async () => ({
    registrations: [{ workerName: "claude-impl", roleCeiling: "implementation" }],
    derived: { v22: [{ worker_name: "claude-impl", model: "claude-sonnet-5",
      routing_roles: ["implement", "investigate"] }] },
  }),
} });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: {
  registryRowToModel: (row: Record<string, unknown>) => {
    if (row.broken) throw new Error("invalid registry row");
    return { ...row, usageClass: "standard", maxOutputTokens: undefined,
      reservationOutputTokens: undefined };
  },
} });

let rows: Array<Record<string, unknown>> = [];
const tx = {
  modelRegistryEntry: { findMany: async () => rows },
  $queryRaw: async () => [{ now: NOW }],
};
// A real model id, so its verified cache-write rate comes from lib/modelPricing.ts.
const row = (overrides: Record<string, unknown> = {}) => ({ id: "claude-sonnet-5",
  apiModel: "claude-sonnet-5", provider: "anthropic",
  inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15,
  cachedInputPriceMultiplier: 0.1, ...overrides });
const service = import(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"));

test("a Task's ceiling comes from the registry price and reproduces at a pinned time", async () => {
  rows = [row()];
  const { calculateCurrentApprovedAmuxV4TaskCost } = await service;
  const live = await calculateCurrentApprovedAmuxV4TaskCost(tx as never, "implement", "advanced");
  // Two attempts, each covering every advanced cap at the route's rates.
  const [route] = live.catalog.routes as Array<Record<string, number>>;
  assert.equal(route.uncachedInputMicroUsdPerMillion, 3_000_000);
  assert.equal(route.outputMicroUsdPerMillion, 15_000_000);
  assert.ok(route.cacheWriteMicroUsdPerMillion >= 6_000_000, "at least the one-hour rate");
  const perAttempt = BigInt(live.receipt.routes[0]!.perAttemptMicroUsd);
  const caps = AMUX_TASK_CATALOG_CAPS.advanced;
  assert.ok(perAttempt >= BigInt(Math.ceil((caps.inputTokens * 3_000_000 +
    caps.cacheReadTokens * 300_000 + caps.cacheWriteTokens * route.cacheWriteMicroUsdPerMillion! +
    caps.outputTokens * 15_000_000) / 1_000_000)));
  assert.ok(perAttempt <= BigInt(AMUX_TASK_ATTEMPT_BUDGET_MAX_MICROUSD),
    "one attempt fits the launcher's budget");
  assert.equal(live.receipt.ceilingMicroUsd, String(perAttempt * BigInt(2)));
  assert.match(live.approvalId, /^registry:[a-f0-9]{32}$/);
  const pinned = await calculateCurrentApprovedAmuxV4TaskCost(tx as never,
    "implement", "advanced", { asOf: new Date("2026-10-20T00:00:00.000Z") });
  assert.equal(pinned.receipt.calculatedAtIso, "2026-10-20T00:00:00.000Z");
  assert.equal(pinned.catalogDigest, live.catalogDigest);
  rows = [row({ inputUsdPerMillionTokens: 3.5 })];
  const repriced = await calculateCurrentApprovedAmuxV4TaskCost(tx as never,
    "implement", "advanced", { asOf: new Date("2026-10-20T00:00:00.000Z") });
  assert.notEqual(repriced.catalogDigest, live.catalogDigest,
    "a changed price shows as a changed catalog, so the caller reconfirms");
});

test("a price too dear for one attempt's budget is a hold, not an assignment", async () => {
  const { calculateCurrentApprovedAmuxV4TaskCost } = await service;
  rows = [row({ inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 50 })];
  await assert.rejects(calculateCurrentApprovedAmuxV4TaskCost(tx as never, "implement", "advanced"),
    { name: "AmuxV4TaskCatalogApprovalError" });
});

test("no worker for the role, or no model in the registry, is a hold", async () => {
  const { calculateCurrentApprovedAmuxV4TaskCost } = await service;
  rows = [row()];
  await assert.rejects(calculateCurrentApprovedAmuxV4TaskCost(tx as never, "test", "advanced"),
    { name: "AmuxV4TaskCatalogApprovalError" });
  rows = [];
  await assert.rejects(calculateCurrentApprovedAmuxV4TaskCost(tx as never, "implement", "advanced"),
    { name: "AmuxV4TaskCatalogApprovalError" });
});

test("an API-model match takes the dearest row, so a duplicate never lowers the price", async () => {
  const { readAmuxV4TaskAutoCatalog } = await service;
  // Two real model profiles (each with a verified write rate) both calling
  // the API model the worker names; neither row has its id.
  rows = [row({ id: "claude-opus-4-8", inputUsdPerMillionTokens: 1 }),
    row({ id: "claude-haiku-4-5", inputUsdPerMillionTokens: 2 })].map((entry) =>
    ({ ...entry, apiModel: "claude-sonnet-5" }));
  for (const entry of rows) assert.notEqual(entry.id, "claude-sonnet-5");
  const result = await readAmuxV4TaskAutoCatalog(tx as never);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const routes = result.catalog.routes as Array<Record<string, unknown>>;
  assert.equal(routes[0]?.uncachedInputMicroUsdPerMillion, 2_000_000);
});

test("an unreadable row that might be the dearest prices nothing", async () => {
  const { readAmuxV4TaskAutoCatalog } = await service;
  rows = [row({ id: "claude-opus-4-8", inputUsdPerMillionTokens: 1 }),
    row({ id: "row-broken", broken: true })].map((entry) =>
    ({ ...entry, apiModel: "claude-sonnet-5" }));
  assert.deepEqual(await readAmuxV4TaskAutoCatalog(tx as never),
    { ok: false, code: "no_priced_worker" });
  rows = [row({ broken: true }), row({ id: "claude-opus-4-8", apiModel: "claude-sonnet-5",
    inputUsdPerMillionTokens: 1 })];
  assert.deepEqual(await readAmuxV4TaskAutoCatalog(tx as never),
    { ok: false, code: "no_priced_worker" }, "an unreadable exact row never falls through");
});
