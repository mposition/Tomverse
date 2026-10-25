import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The Task cost catalog is derived from the registries (owner decision
// 2026-10-25). These pin what an approved catalog row used to guarantee:
// a pinned receipt either reproduces or reports a changed cost, and a past
// price that cannot be proven is left unpriced.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const CHANGED_AT = new Date("2026-10-20T03:00:00.900Z");
const NOW = new Date("2026-10-25T00:00:00.000Z");

mock.module(mod("lib/amux/workerAssignmentCatalog.ts"), { namedExports: {
  readAmuxRegistryAndDerivedCatalog: async () => ({
    registrations: [{ workerName: "claude-impl", roleCeiling: "implementation" }],
    derived: { v22: [{ worker_name: "claude-impl", model: "claude-draft-test",
      routing_roles: ["implement", "investigate"] }] },
  }),
} });
mock.module(mod("lib/modelRegistry.ts"), { namedExports: {
  registryRowToModel: (row: Record<string, unknown>) => ({ ...row,
    usageClass: "standard", maxOutputTokens: undefined,
    reservationOutputTokens: undefined }),
} });

const tx = {
  modelRegistryEntry: { findMany: async () => [{ id: "claude-draft-test",
    apiModel: "claude-draft-test", provider: "anthropic", updatedAt: CHANGED_AT,
    inputUsdPerMillionTokens: undefined, outputUsdPerMillionTokens: undefined,
    cachedInputPriceMultiplier: undefined }] },
  $queryRaw: async () => [{ now: NOW }],
};
const service = import(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"));

test("a receipt pinned before a price change returns the live cost instead of throwing", async () => {
  const { calculateCurrentApprovedAmuxV4TaskCost } = await service;
  const before = await calculateCurrentApprovedAmuxV4TaskCost(tx as never,
    "implement", "advanced", { asOf: new Date("2026-10-20T03:00:00.500Z") });
  assert.equal(before.receipt.calculatedAtIso, NOW.toISOString(),
    "the caller sees a changed receipt and takes its cost-changed path");
  const after = await calculateCurrentApprovedAmuxV4TaskCost(tx as never,
    "implement", "advanced", { asOf: new Date("2026-10-22T00:00:00.000Z") });
  assert.equal(after.receipt.calculatedAtIso, "2026-10-22T00:00:00.000Z",
    "a pin after the change still reproduces");
  assert.match(after.approvalId, /^registry:[a-f0-9]{32}$/);
  await assert.rejects(calculateCurrentApprovedAmuxV4TaskCost(tx as never,
    "test", "advanced"), { name: "AmuxV4TaskCatalogApprovalError" },
  "no worker runs test Tasks, so there is no ceiling to reserve");
});

test("a price under an environment override is not used for past usage", async () => {
  const { readAmuxV4TaskAutoCatalog } = await service;
  const key = "CHAT_MODEL_CLAUDE_DRAFT_TEST_INPUT_USD_PER_MILLION";
  const saved = process.env[key];
  process.env[key] = "0.01";
  try {
    assert.equal((await readAmuxV4TaskAutoCatalog(tx as never)).ok, true,
      "today's ceiling may use today's override");
    assert.deepEqual(await readAmuxV4TaskAutoCatalog(tx as never,
      { at: new Date("2026-10-21T00:00:00.000Z") }), { ok: false, code: "no_priced_worker" });
  } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  }
  assert.equal((await readAmuxV4TaskAutoCatalog(tx as never,
    { at: new Date("2026-10-21T00:00:00.000Z") })).ok, true);
});
