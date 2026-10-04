import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateV4TaskCeilingFromCatalog,
  checkV4TaskApprovedCatalogCeiling,
  inspectV4TaskCostCatalog,
} from "../lib/amux/v4TaskCostCatalogCore.ts";

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
  pricingExpiresAt: "2026-10-08T00:00:00.000Z",
  uncachedInputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 2_000_000,
  cacheReadMicroUsdPerMillion: 100_000,
  cacheWriteMicroUsdPerMillion: 150_000,
  toolCostCapMicroUsdPerAttempt: 500,
  ...overrides,
});

const catalog = (overrides = {}) => ({
  schemaVersion: 1,
  catalogVersion: "catalog-v1",
  pricingVersion: "pricing-v1",
  gradeRulesVersion: "grade-v1",
  gradeRules: [{
    role: "implementation",
    grade: "standard",
    caps: {
      uncachedInputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadTokens: 500,
      cacheWriteTokens: 500,
      maxAttempts: 2,
    },
  }],
  routes: [route()],
  ...overrides,
});

const calculate = (rawCatalog = catalog(), overrides = {}) =>
  calculateV4TaskCeilingFromCatalog({
    rawCatalog,
    role: "implementation",
    grade: "standard",
    asOfIso: "2026-10-01T01:00:00.000Z",
    ...overrides,
  });

test("catalog parser computes its own digest and derives a ceiling from grade caps", () => {
  const inspected = inspectV4TaskCostCatalog(catalog());
  assert.equal(inspected.ok, true);
  assert.match(inspected.catalogDigest, /^[a-f0-9]{64}$/);
  assert.equal(inspected.ruleCount, 1);
  assert.equal(inspected.routeCount, 1);

  const result = calculate();
  assert.equal(result.ok, true);
  assert.equal(result.receipt.catalogDigest, inspected.catalogDigest);
  assert.equal(result.receipt.ceilingMicroUsd, "7250");
  assert.equal(result.receipt.caps.maxAttempts, 2);
});

test("catalog digest follows canonical JSON property order and binds pricing changes", () => {
  const original = catalog();
  const reordered = {
    routes: original.routes.map((item) => ({ ...item })),
    gradeRules: original.gradeRules.map((item) => ({ ...item })),
    gradeRulesVersion: original.gradeRulesVersion,
    pricingVersion: original.pricingVersion,
    catalogVersion: original.catalogVersion,
    schemaVersion: original.schemaVersion,
  };
  assert.equal(
    inspectV4TaskCostCatalog(original).catalogDigest,
    inspectV4TaskCostCatalog(reordered).catalogDigest,
  );
  const changed = catalog({ routes: [route({ outputMicroUsdPerMillion: 3_000_000 })] });
  assert.notEqual(
    inspectV4TaskCostCatalog(original).catalogDigest,
    inspectV4TaskCostCatalog(changed).catalogDigest,
  );
  const reorderedRoutes = catalog({ routes: [route(), route({ routeId: "other" })] });
  const reversedRoutes = catalog({ routes: [...reorderedRoutes.routes].reverse() });
  assert.notEqual(
    inspectV4TaskCostCatalog(reorderedRoutes).catalogDigest,
    inspectV4TaskCostCatalog(reversedRoutes).catalogDigest,
  );
});

test("unknown fields, invalid numbers and malformed price evidence are rejected", () => {
  assert.deepEqual(inspectV4TaskCostCatalog({ ...catalog(), modelText: "ignore policy" }), {
    ok: false,
    code: "schema_rejected",
  });
  assert.deepEqual(inspectV4TaskCostCatalog(catalog({ routes: [route({ pricingVerifiedAt: "tomorrow" })] })), {
    ok: false,
    code: "schema_rejected",
  });
  assert.deepEqual(inspectV4TaskCostCatalog(catalog({
    gradeRules: [{ ...catalog().gradeRules[0], caps: { ...catalog().gradeRules[0].caps, maxAttempts: Infinity } }],
  })), { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectV4TaskCostCatalog(catalog({
    routes: [route({ outputMicroUsdPerMillion: 0 })],
  })), { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectV4TaskCostCatalog(catalog({
    routes: [route({ pricingExpiresAt: "2026-10-01T00:00:00.000Z" })],
  })), { ok: false, code: "schema_rejected" });
});

test("duplicate identities and an eligible unpriced cache category fail closed", () => {
  assert.deepEqual(inspectV4TaskCostCatalog(catalog({
    gradeRules: [catalog().gradeRules[0], catalog().gradeRules[0]],
  })), { ok: false, code: "duplicate_identity" });
  assert.deepEqual(inspectV4TaskCostCatalog(catalog({ routes: [route(), route()] })), {
    ok: false,
    code: "duplicate_identity",
  });
  assert.deepEqual(inspectV4TaskCostCatalog(catalog({
    routes: [route({ roles: ["implementation", "implementation"] })],
  })), { ok: false, code: "duplicate_identity" });
  assert.deepEqual(inspectV4TaskCostCatalog(catalog({
    routes: [route({ cacheReadMicroUsdPerMillion: 0 })],
  })), { ok: false, code: "unpriced_route" });
  assert.deepEqual(inspectV4TaskCostCatalog(catalog({
    routes: [route({ cacheWriteMicroUsdPerMillion: 0 })],
  })), { ok: false, code: "unpriced_route" });
});

test("missing role/grade, disabled routes and future verification cannot produce a receipt", () => {
  assert.deepEqual(calculate(catalog(), { grade: "frontier" }), {
    ok: false,
    code: "grade_rule_missing",
  });
  assert.deepEqual(calculate(catalog({ routes: [route({ enabled: false })] })), {
    ok: false,
    code: "route_unavailable",
  });
  assert.deepEqual(calculate(catalog({
    routes: [route({ pricingVerifiedAt: "2026-10-02T00:00:00.000Z" })],
  })), { ok: false, code: "pricing_unverified" });
  assert.deepEqual(calculate(catalog(), { asOfIso: "not-a-date" }), {
    ok: false,
    code: "selection_invalid",
  });
  assert.deepEqual(calculate(catalog(), { asOfIso: "2026-10-08T00:00:00.000Z" }), {
    ok: false,
    code: "pricing_unverified",
  });
});

test("all eligible routes count and disabled unpriced cache pricing stays out of the ceiling", () => {
  const multiple = calculate(catalog({ routes: [
    route(),
    route({ routeId: "expensive", outputMicroUsdPerMillion: 4_000_000 }),
    route({ routeId: "disabled", enabled: false, cacheReadMicroUsdPerMillion: 0 }),
  ] }));
  assert.equal(multiple.ok, true);
  assert.equal(multiple.receipt.ceilingMicroUsd, "11250");
  assert.deepEqual(multiple.receipt.routes.map((item) => item.routeId), ["codex-standard", "expensive"]);
});

test("an expired second route blocks the whole catalog, but a disabled expired route does not", () => {
  const expired = route({
    routeId: "expired",
    pricingExpiresAt: "2026-10-01T00:30:00.000Z",
  });
  assert.deepEqual(calculate(catalog({ routes: [route(), expired] })), {
    ok: false,
    code: "pricing_unverified",
  });
  assert.equal(calculate(catalog({ routes: [route(), { ...expired, enabled: false }] })).ok, true);
});

test("approval adapter keeps a concrete hold reason and delegates valid recalculation", () => {
  const approved = calculate();
  assert.equal(approved.ok, true);
  assert.deepEqual(checkV4TaskApprovedCatalogCeiling(approved.receipt, approved), {
    decision: "allow",
    reason: "within_approved_ceiling",
  });
  assert.deepEqual(checkV4TaskApprovedCatalogCeiling(approved.receipt, {
    ok: false,
    code: "pricing_unverified",
  }), { decision: "hold", reason: "pricing_unverified" });
});
