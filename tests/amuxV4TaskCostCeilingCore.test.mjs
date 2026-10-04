import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateV4TaskCostCeiling,
  checkV4TaskApprovedCeiling,
} from "../lib/amux/v4TaskCostCeilingCore.ts";

const route = (overrides = {}) => ({
  routeId: "codex-standard",
  workerName: "worker-codex",
  provider: "codex",
  modelId: "verified-model-a",
  routePolicyDigest: "b".repeat(64),
  enabled: true,
  roles: ["implementation"],
  grades: ["standard"],
  pricingSource: "verified-price-record",
  pricingVerifiedAt: "2026-10-01T00:00:00.000Z",
  uncachedInputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 2_000_000,
  cacheReadMicroUsdPerMillion: 100_000,
  cacheWriteMicroUsdPerMillion: 150_000,
  toolCostCapMicroUsdPerAttempt: 500,
  ...overrides,
});

const input = (overrides = {}) => ({
  role: "implementation",
  grade: "standard",
  catalogVersion: "catalog-v1",
  catalogDigest: "a".repeat(64),
  pricingVersion: "pricing-v1",
  gradeRulesVersion: "grade-v1",
  asOfIso: "2026-10-01T01:00:00.000Z",
  caps: {
    uncachedInputTokens: 1_000,
    outputTokens: 1_000,
    cacheReadTokens: 500,
    cacheWriteTokens: 500,
    maxAttempts: 2,
  },
  routes: [route()],
  ...overrides,
});

test("v4 Task ceiling uses the most expensive eligible route across all attempts", () => {
  const result = calculateV4TaskCostCeiling(input({
    routes: [
      route(),
      route({
        routeId: "claude-frontier",
        workerName: "worker-claude",
        provider: "claude",
        modelId: "verified-model-b",
        outputMicroUsdPerMillion: 4_000_000,
      }),
      route({ routeId: "disabled", enabled: false, outputMicroUsdPerMillion: 9_000_000 }),
    ],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.receipt.ceilingMicroUsd, "11250");
  assert.deepEqual(result.receipt.routes.map((item) => item.routeId), [
    "claude-frontier",
    "codex-standard",
  ]);
  assert.equal(result.receipt.routes[1].perAttemptMicroUsd, "3625");
});

test("receipt digest is stable across catalog and cap property order", () => {
  const routeA = route();
  const routeB = route({ routeId: "other", workerName: "other-worker" });
  const first = calculateV4TaskCostCeiling(input({ routes: [routeA, routeB] }));
  const second = calculateV4TaskCostCeiling(input({
    caps: {
      maxAttempts: 2,
      cacheWriteTokens: 500,
      cacheReadTokens: 500,
      outputTokens: 1_000,
      uncachedInputTokens: 1_000,
    },
    routes: [routeB, routeA],
  }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.receipt.receiptDigest, second.receipt.receiptDigest);
});

test("rounds every token category upward and never treats missing price as free", () => {
  const tiny = calculateV4TaskCostCeiling(input({
    caps: {
      uncachedInputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      maxAttempts: 1,
    },
    routes: [route({
      uncachedInputMicroUsdPerMillion: 1,
      outputMicroUsdPerMillion: 1,
      cacheReadMicroUsdPerMillion: 1,
      cacheWriteMicroUsdPerMillion: 1,
      toolCostCapMicroUsdPerAttempt: 0,
    })],
  }));
  assert.equal(tiny.ok, true);
  assert.equal(tiny.receipt.ceilingMicroUsd, "4");

  assert.deepEqual(
    calculateV4TaskCostCeiling(input({ routes: [route({ cacheReadMicroUsdPerMillion: null })] })),
    { ok: false, reason: "pricing_unverified" },
  );
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({ routes: [route(), route({ routeId: "unpriced", modelId: "other", pricingSource: "" })] })),
    { ok: false, reason: "pricing_unverified" },
  );
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({ routes: [route({ uncachedInputMicroUsdPerMillion: 0 })] })),
    { ok: false, reason: "pricing_unverified" },
  );
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({ routes: [route({ cacheReadMicroUsdPerMillion: 0 })] })),
    { ok: false, reason: "pricing_unverified" },
  );
});

test("missing version, invalid caps, unavailable route, duplicate route and overflow fail closed", () => {
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({ catalogDigest: "unverified" })),
    { ok: false, reason: "basis_missing" },
  );
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({ caps: { ...input().caps, maxAttempts: 0 } })),
    { ok: false, reason: "caps_invalid" },
  );
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({ routes: [route({ grades: ["frontier"] })] })),
    { ok: false, reason: "route_unavailable" },
  );
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({ routes: [route(), route({ modelId: "other" })] })),
    { ok: false, reason: "route_duplicate" },
  );
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({ routes: [route(), route({ enabled: false, modelId: "other" })] })),
    { ok: false, reason: "route_duplicate" },
  );
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({
      caps: { ...input().caps, uncachedInputTokens: Number.MAX_SAFE_INTEGER },
      routes: [route({ uncachedInputMicroUsdPerMillion: Number.MAX_SAFE_INTEGER })],
    })),
    { ok: false, reason: "amount_overflow" },
  );
  assert.deepEqual(
    calculateV4TaskCostCeiling(input({
      caps: { ...input().caps, maxAttempts: Number.MAX_SAFE_INTEGER },
    })),
    { ok: false, reason: "amount_overflow" },
  );
});

test("malformed catalog structure and non-canonical price evidence return a refusal", () => {
  const missing = { ok: false, reason: "basis_missing" };
  assert.deepEqual(calculateV4TaskCostCeiling(null), missing);
  assert.deepEqual(calculateV4TaskCostCeiling(input({ routes: null })), missing);
  assert.deepEqual(calculateV4TaskCostCeiling(input({ routes: [null] })), missing);
  assert.deepEqual(calculateV4TaskCostCeiling(input({ routes: [route({ enabled: "false" })] })), missing);
  assert.deepEqual(calculateV4TaskCostCeiling(input({ routes: [route({ roles: "implementation" })] })), missing);
  assert.deepEqual(calculateV4TaskCostCeiling(input({ routes: [route({ grades: "standard" })] })), missing);
  assert.deepEqual(calculateV4TaskCostCeiling(input({ caps: null })), { ok: false, reason: "caps_invalid" });
  assert.deepEqual(calculateV4TaskCostCeiling(input({
    caps: { ...input().caps, outputTokens: "1000" },
  })), { ok: false, reason: "caps_invalid" });
  assert.deepEqual(calculateV4TaskCostCeiling(input({
    caps: { ...input().caps, unexpected: "model text" },
  })), { ok: false, reason: "caps_invalid" });
  assert.deepEqual(calculateV4TaskCostCeiling(input({
    routes: [route({ pricingVerifiedAt: "2026" })],
  })), { ok: false, reason: "pricing_unverified" });
  assert.deepEqual(calculateV4TaskCostCeiling(input({
    routes: [route({ pricingVerifiedAt: "2026-10-02T00:00:00.000Z" })],
  })), { ok: false, reason: "pricing_unverified" });
});

test("execution allows a lower current ceiling only on the approved route and caps", () => {
  const approvedResult = calculateV4TaskCostCeiling(input());
  assert.equal(approvedResult.ok, true);
  const approved = approvedResult.receipt;

  assert.deepEqual(checkV4TaskApprovedCeiling(approved, approvedResult), {
    decision: "allow",
    reason: "within_approved_ceiling",
  });
  const cheaper = calculateV4TaskCostCeiling(input({
    pricingVersion: "pricing-v2",
    routes: [route({ outputMicroUsdPerMillion: 1_000_000 })],
  }));
  assert.deepEqual(checkV4TaskApprovedCeiling(approved, cheaper), {
    decision: "allow",
    reason: "within_approved_ceiling",
  });
  const dearer = calculateV4TaskCostCeiling(input({
    pricingVersion: "pricing-v3",
    routes: [route({ outputMicroUsdPerMillion: 3_000_000 })],
  }));
  assert.deepEqual(checkV4TaskApprovedCeiling(approved, dearer), {
    decision: "reconfirm",
    reason: "ceiling_increased",
  });
});

test("route identity and resource bounds cannot drift beneath an unchanged ceiling", () => {
  const old = calculateV4TaskCostCeiling(input());
  assert.equal(old.ok, true);

  const switchedModel = calculateV4TaskCostCeiling(input({
    routes: [route({ modelId: "different-model", outputMicroUsdPerMillion: 1_000_000 })],
  }));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, switchedModel), {
    decision: "reconfirm",
    reason: "task_route_changed",
  });
  const switchedPolicy = calculateV4TaskCostCeiling(input({
    routes: [route({ routePolicyDigest: "c".repeat(64), outputMicroUsdPerMillion: 1_000_000 })],
  }));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, switchedPolicy), {
    decision: "reconfirm",
    reason: "task_route_changed",
  });
  const newRoute = calculateV4TaskCostCeiling(input({
    routes: [route(), route({ routeId: "another", workerName: "another-worker" })],
  }));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, newRoute), {
    decision: "reconfirm",
    reason: "task_route_changed",
  });

  const moreAttempts = calculateV4TaskCostCeiling(input({
    caps: { ...input().caps, maxAttempts: 3 },
    routes: [route({ outputMicroUsdPerMillion: 500_000 })],
  }));
  assert.ok(BigInt(moreAttempts.receipt.ceilingMicroUsd) <= BigInt(old.receipt.ceilingMicroUsd));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, moreAttempts), {
    decision: "reconfirm",
    reason: "task_bounds_increased",
  });
});

test("unverified current basis and invalid approval stay on hold", () => {
  const old = calculateV4TaskCostCeiling(input());
  assert.equal(old.ok, true);
  const unpriced = calculateV4TaskCostCeiling(input({ routes: [route({ pricingSource: "" })] }));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, unpriced), {
    decision: "hold",
    reason: "pricing_unverified",
  });
  assert.deepEqual(checkV4TaskApprovedCeiling({ ...old.receipt, ceilingMicroUsd: "unknown" }, old), {
    decision: "hold",
    reason: "approval_invalid",
  });
  assert.deepEqual(checkV4TaskApprovedCeiling({ ...old.receipt, routes: null }, old), {
    decision: "hold",
    reason: "approval_invalid",
  });
  assert.deepEqual(checkV4TaskApprovedCeiling({
    ...old.receipt,
    catalogVersion: "modified-after-approval",
  }, old), { decision: "hold", reason: "approval_invalid" });
  assert.deepEqual(checkV4TaskApprovedCeiling({
    ...old.receipt,
    ceilingMicroUsd: String(BigInt("9223372036854775807") + BigInt(1)),
  }, old), { decision: "hold", reason: "approval_invalid" });
  assert.deepEqual(checkV4TaskApprovedCeiling({
    ...old.receipt,
    ceilingMicroUsd: "9".repeat(100_000),
  }, old), { decision: "hold", reason: "approval_invalid" });
});
