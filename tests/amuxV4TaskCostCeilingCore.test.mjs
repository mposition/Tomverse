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
  // Owner decision 2026-11-13: one more worker on an approved provider and
  // model is the approved route (codex-chore-2 beside codex-chore). A new
  // model, or a new provider for the same model name, still asks.
  const sameModelWorker = calculateV4TaskCostCeiling(input({
    routes: [route(), route({ routeId: "another", workerName: "another-worker",
      routePolicyDigest: "d".repeat(64) })],
  }));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, sameModelWorker), {
    decision: "allow",
    reason: "within_approved_ceiling",
  });
  for (const changed of [{ modelId: "different-model" }, { provider: "copilot" }]) {
    const newRoute = calculateV4TaskCostCeiling(input({
      routes: [route(), route({ routeId: "another", workerName: "another-worker", ...changed })],
    }));
    assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, newRoute), {
      decision: "reconfirm",
      reason: "task_route_changed",
    }, JSON.stringify(changed));
  }
  // A route the receipt named still has to match it exactly, even when a
  // same-model worker is added beside it.
  const namedRouteChanged = calculateV4TaskCostCeiling(input({
    routes: [route({ routePolicyDigest: "c".repeat(64) }), route({ routeId: "another", workerName: "another-worker" })],
  }));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, namedRouteChanged), {
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

test("an ordinary Task is never stopped by a higher cost, only by a changed route", async () => {
  const { v4TaskCeilingDecision } = await import("../lib/amux/v4TaskCostCeilingCore.ts");
  for (const reason of ["ceiling_increased", "task_bounds_increased"]) {
    assert.equal(v4TaskCeilingDecision({ decision: "reconfirm", reason }, false), "allow", reason);
    assert.equal(v4TaskCeilingDecision({ decision: "reconfirm", reason }, true), "reconfirm",
      `an owner-approved recovery keeps ${reason}`);
  }
  assert.equal(v4TaskCeilingDecision({ decision: "reconfirm", reason: "task_route_changed" }, false),
    "reconfirm", "a route outside the confirmed receipt still needs the owner");
  assert.equal(v4TaskCeilingDecision({ decision: "hold", reason: "approval_invalid" }, false), "hold");
  assert.equal(v4TaskCeilingDecision({ decision: "allow", reason: "within_approved_ceiling" }, true), "allow");
});

test("a new model route within the approved ceiling passes only behind its switch", async () => {
  const { AMUX_V4_NEW_MODEL_ROUTE_ENV, amuxV4NewModelRouteWithinCeiling } =
    await import("../lib/amux/v4TaskNewModelRouteSwitch.ts");
  assert.equal(AMUX_V4_NEW_MODEL_ROUTE_ENV, "TOMVERSE_AMUX_V4_NEW_MODEL_ROUTE_WITHIN_CEILING");
  for (const value of [undefined, "", "true", "1", "Enabled", "disabled"]) {
    assert.deepEqual(amuxV4NewModelRouteWithinCeiling(value),
      { newModelRouteWithinCeiling: false }, String(value));
  }
  const on = amuxV4NewModelRouteWithinCeiling("enabled");
  assert.deepEqual(on, { newModelRouteWithinCeiling: true });

  const old = calculateV4TaskCostCeiling(input());
  assert.equal(old.ok, true);
  // antigravity-impl beside the approved route, on a model the receipt did
  // not name, cheaper than the approved route.
  const added = (overrides = {}) => route({ routeId: "gemini-standard",
    workerName: "antigravity-impl", provider: "google", modelId: "gemini-4-argon-medium",
    routePolicyDigest: "e".repeat(64), outputMicroUsdPerMillion: 1_500_000, ...overrides });
  const withNew = calculateV4TaskCostCeiling(input({ routes: [route(), added()] }));
  assert.equal(withNew.ok, true);

  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, withNew), {
    decision: "reconfirm", reason: "task_route_changed" }, "default off keeps the old rule");
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, withNew,
    { newModelRouteWithinCeiling: false }),
  { decision: "reconfirm", reason: "task_route_changed" });
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, withNew, on), {
    decision: "allow", reason: "new_model_route_within_ceiling" });

  // Exactly at the approved ceiling still passes; one micro-dollar over asks.
  const approvedPerAttempt = BigInt(old.receipt.ceilingMicroUsd) / BigInt(2);
  const atCeiling = calculateV4TaskCostCeiling(input({ routes: [route(), added({
    outputMicroUsdPerMillion: 2_000_000 })] }));
  const atCeilingRoute = atCeiling.receipt.routes.find((r) => r.routeId === "gemini-standard");
  assert.equal(BigInt(atCeilingRoute.perAttemptMicroUsd), approvedPerAttempt);
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, atCeiling, on), {
    decision: "allow", reason: "new_model_route_within_ceiling" });
  const dearer = calculateV4TaskCostCeiling(input({ routes: [route(), added({
    outputMicroUsdPerMillion: 2_000_000, toolCostCapMicroUsdPerAttempt: 501 })] }));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, dearer, on), {
    decision: "reconfirm", reason: "task_route_changed" }, "a new route over the ceiling asks");
  const { v4TaskCeilingDecision } = await import("../lib/amux/v4TaskCostCeilingCore.ts");
  assert.equal(v4TaskCeilingDecision(checkV4TaskApprovedCeiling(old.receipt, dearer, on), false),
    "reconfirm", "an ordinary Task does not pass a new route over the ceiling");
  assert.equal(v4TaskCeilingDecision(checkV4TaskApprovedCeiling(old.receipt, withNew, on), false),
    "allow");

  // Grown bounds with a new model route ask, even below the old ceiling.
  const grown = calculateV4TaskCostCeiling(input({
    caps: { ...input().caps, outputTokens: 1_001 },
    routes: [route({ outputMicroUsdPerMillion: 1_000_000 }), added({ outputMicroUsdPerMillion: 500_000 })],
  }));
  assert.ok(BigInt(grown.receipt.ceilingMicroUsd) < BigInt(old.receipt.ceilingMicroUsd));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, grown, on), {
    decision: "reconfirm", reason: "task_route_changed" });
  const moreAttempts = calculateV4TaskCostCeiling(input({
    caps: { ...input().caps, maxAttempts: 3 },
    routes: [route({ outputMicroUsdPerMillion: 100_000 }), added({ outputMicroUsdPerMillion: 100_000 })],
  }));
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, moreAttempts, on), {
    decision: "reconfirm", reason: "task_route_changed" });

  // A route the receipt named still has to match it exactly.
  for (const changed of [{ modelId: "different-model" }, { routePolicyDigest: "c".repeat(64) },
    { workerName: "renamed-worker" }]) {
    const namedChanged = calculateV4TaskCostCeiling(input({
      routes: [route(changed), added()] }));
    assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, namedChanged, on), {
      decision: "reconfirm", reason: "task_route_changed" }, JSON.stringify(changed));
  }
  // The switch does not loosen hold reasons or an invalid approval.
  assert.deepEqual(checkV4TaskApprovedCeiling({ ...old.receipt, ceilingMicroUsd: "1" }, withNew, on),
    { decision: "hold", reason: "approval_invalid" });
  // With no new model route the reasons are unchanged.
  assert.deepEqual(checkV4TaskApprovedCeiling(old.receipt, old, on), {
    decision: "allow", reason: "within_approved_ceiling" });
});

test("a new model route the approval cannot run on is left out for the Task, not a reason to stop it", async () => {
  const { v4TaskCeilingDecision, v4TaskReceiptForApprovedRoutes } =
    await import("../lib/amux/v4TaskCostCeilingCore.ts");
  const on = { newModelRouteWithinCeiling: true };
  const approved = calculateV4TaskCostCeiling(input()).receipt;
  // 2026-11-14: antigravity-impl joined on a new, dearer model; the approved
  // route is unchanged and idle.
  const dear = route({ routeId: "gemini-standard", workerName: "antigravity-impl",
    provider: "google", modelId: "gemini-4-argon-medium", routePolicyDigest: "e".repeat(64),
    outputMicroUsdPerMillion: 9_000_000 });
  const cheap = route({ routeId: "grok-standard", workerName: "cursor-impl",
    provider: "cursor", modelId: "grok-4.7-high", routePolicyDigest: "f".repeat(64),
    outputMicroUsdPerMillion: 1_000_000 });
  const sibling = route({ routeId: "codex-standard-2", workerName: "worker-codex-2" });
  const current = calculateV4TaskCostCeiling(input({ routes: [route(), dear, cheap, sibling] })).receipt;
  assert.ok(BigInt(current.ceilingMicroUsd) > BigInt(approved.ceilingMicroUsd));
  assert.deepEqual(checkV4TaskApprovedCeiling(approved, { ok: true, receipt: current }, on), {
    decision: "reconfirm", reason: "task_route_changed" }, "the whole receipt still asks");

  // Switch on: the dear new model is left out, the cheap one and the sibling stay.
  const runnable = v4TaskReceiptForApprovedRoutes(approved, current, on);
  assert.deepEqual(runnable.routes.map((r) => r.routeId).sort(),
    ["codex-standard", "codex-standard-2", "grok-standard"]);
  assert.equal(BigInt(runnable.ceilingMicroUsd) <= BigInt(approved.ceilingMicroUsd), true);
  assert.deepEqual(checkV4TaskApprovedCeiling(approved, { ok: true, receipt: runnable }, on), {
    decision: "allow", reason: "new_model_route_within_ceiling" });
  assert.equal(v4TaskCeilingDecision(checkV4TaskApprovedCeiling(approved,
    { ok: true, receipt: runnable }, on), false), "allow");

  // Switch off: every new model is left out; the approved model's routes run.
  const off = v4TaskReceiptForApprovedRoutes(approved, current, {});
  assert.deepEqual(off.routes.map((r) => r.routeId).sort(), ["codex-standard", "codex-standard-2"]);
  assert.deepEqual(checkV4TaskApprovedCeiling(approved, { ok: true, receipt: off }), {
    decision: "allow", reason: "within_approved_ceiling" });

  // Nothing to leave out: the same object comes back.
  const same = calculateV4TaskCostCeiling(input({ routes: [route(), sibling] })).receipt;
  assert.equal(v4TaskReceiptForApprovedRoutes(approved, same, on), same);
});

test("leaving routes out never hides a changed approved route or an invalid approval", async () => {
  const { v4TaskReceiptForApprovedRoutes } = await import("../lib/amux/v4TaskCostCeilingCore.ts");
  const on = { newModelRouteWithinCeiling: true };
  const approved = calculateV4TaskCostCeiling(input()).receipt;
  const dear = route({ routeId: "gemini-standard", workerName: "antigravity-impl",
    provider: "google", modelId: "gemini-4-argon-medium", routePolicyDigest: "e".repeat(64),
    outputMicroUsdPerMillion: 9_000_000 });
  for (const changed of [{ modelId: "different-model" }, { routePolicyDigest: "c".repeat(64) },
    { workerName: "renamed-worker" }]) {
    const current = calculateV4TaskCostCeiling(input({ routes: [route(changed), dear] })).receipt;
    const runnable = v4TaskReceiptForApprovedRoutes(approved, current, on);
    assert.ok(runnable.routes.some((r) => r.routeId === "codex-standard"), "the named route stays");
    assert.deepEqual(checkV4TaskApprovedCeiling(approved, { ok: true, receipt: runnable }, on), {
      decision: "reconfirm", reason: "task_route_changed" }, JSON.stringify(changed));
  }
  // Grown bounds: a new model is left out even under the switch; the bound
  // itself is still reported by the check.
  const grown = calculateV4TaskCostCeiling(input({ caps: { ...input().caps, outputTokens: 1_001 },
    routes: [route(), route({ routeId: "grok-standard", workerName: "cursor-impl", provider: "cursor",
      modelId: "grok-4.7-high", routePolicyDigest: "f".repeat(64), outputMicroUsdPerMillion: 100_000 })] })).receipt;
  assert.deepEqual(v4TaskReceiptForApprovedRoutes(approved, grown, on).routes.map((r) => r.routeId),
    ["codex-standard"]);
  // Another role or grade, or an approval that does not verify: unchanged.
  const current = calculateV4TaskCostCeiling(input({ routes: [route(), dear] })).receipt;
  assert.equal(v4TaskReceiptForApprovedRoutes({ ...approved, receiptDigest: "0".repeat(64) }, current, on), current);
  assert.equal(v4TaskReceiptForApprovedRoutes(null, current, on), current);
  assert.equal(v4TaskReceiptForApprovedRoutes(approved, { ...current, grade: "advanced" }, on).routes.length, 2);
});

test("readiness, claim and execution start judge and offer only the narrowed routes", async () => {
  const { readFileSync } = await import("node:fs");
  const ready = readFileSync("lib/amux/v4TaskReadyService.ts", "utf8");
  assert.match(ready, /v4TaskReceiptForApprovedRoutes\(approvedCost, current\.receipt, routeOptions\)/);
  assert.match(ready, /\{ ok: true, receipt: runnable \}/);
  assert.match(ready, /workerNames = gradeCatalogValid \? runnable\.routes\.filter/);
  const claim = readFileSync("lib/amux/v22WorkerClaimService.ts", "utf8");
  assert.match(claim, /const runnable = recovery \? approved\.receipt :/);
  assert.match(claim, /const matchingRoutes = runnable\.routes\.filter/);
  // The resume pick reads its routes from the narrowed candidates.
  assert.match(claim, /const quotaRoutes = matchingRoutes\.filter/);
  const start = readFileSync("lib/amux/execution.ts", "utf8");
  assert.match(start, /const runnable = assignment\.recoveryApprovalId \? cost\.receipt :/);
  assert.match(start, /const route = runnable\.routes\.find/);
});
