import assert from "node:assert/strict";
import test from "node:test";

import { calculateV4TaskCostCeiling } from "../lib/amux/v4TaskCostCeilingCore.ts";
import { AMUX_GRADE_ESCALATED_ACTION, readAmuxV52TaskReceipt } from
  "../lib/amux/v52GradeReceipt.ts";

const receipt = (grade) => {
  const result = calculateV4TaskCostCeiling({
    role: "implement", grade, catalogVersion: "catalog-v1",
    catalogDigest: "a".repeat(64), pricingVersion: "pricing-v1",
    gradeRulesVersion: "grade-v1", asOfIso: "2026-10-01T01:00:00.000Z",
    caps: { uncachedInputTokens: 1000, outputTokens: 1000,
      cacheReadTokens: 500, cacheWriteTokens: 500, maxAttempts: 2 },
    routes: [{ routeId: `route-${grade}`, workerName: `worker-${grade}`,
      provider: "codex", modelId: "verified-model",
      routePolicyDigest: "b".repeat(64), enabled: true,
      roles: ["implement"], grades: [grade],
      pricingSource: "verified-price-record",
      pricingVerifiedAt: "2026-10-01T00:00:00.000Z",
      uncachedInputMicroUsdPerMillion: 1_000_000,
      outputMicroUsdPerMillion: 2_000_000,
      cacheReadMicroUsdPerMillion: 100_000,
      cacheWriteMicroUsdPerMillion: 150_000,
      toolCostCapMicroUsdPerAttempt: 500 }],
  });
  assert.equal(result.ok, true);
  return result.receipt;
};

const original = receipt("routine");
const escalated = receipt("frontier");
const transaction = (rows) => ({ adminAuditLog: {
  findMany: async (query) => {
    assert.deepEqual(query.where, {
      action: AMUX_GRADE_ESCALATED_ACTION,
      targetType: "AmuxWorkItem", targetId: "task-one",
    });
    assert.equal(query.take, 2);
    return rows;
  },
} });
const audit = (overrides = {}) => ({ entryHash: "c".repeat(64),
  actorUserId: null, actorEmail: null, ipAddress: null, userAgent: null,
  metadata: { systemActor: "tomverse-amux-orchestrator",
    classificationFailure: true, reason: "contract_path_touched",
    originalReceiptDigest: original.receiptDigest,
    previousGrade: "routine", nextGrade: "frontier",
    newReceipt: escalated, ...overrides } });

test("ordinary grade keeps the owner receipt without an escalation lookup", async () => {
  const tx = { adminAuditLog: { findMany: () => {
    throw new Error("unexpected escalation lookup");
  } } };
  assert.deepEqual(await readAmuxV52TaskReceipt(tx, "task-one",
    original, "routine"), original);
});

test("frontier grade requires exactly one digest-bound audited replacement", async () => {
  assert.deepEqual(await readAmuxV52TaskReceipt(transaction([audit()]),
    "task-one", original, "frontier"), escalated);
  for (const rows of [[], [audit(), audit()],
    [audit({ originalReceiptDigest: "d".repeat(64) })],
    [audit({ newReceipt: original })],
    [audit({ reason: "other" })],
    [audit({ systemActor: "other" })],
    [{ ...audit(), actorUserId: "owner" }]]) {
    assert.equal(await readAmuxV52TaskReceipt(transaction(rows),
      "task-one", original, "frontier"), null);
  }
});

test("malformed original receipts and grade changes never borrow an audit", async () => {
  assert.equal(await readAmuxV52TaskReceipt(transaction([audit()]),
    "task-one", { ...original, receiptDigest: "invalid" }, "frontier"), null);
  assert.equal(await readAmuxV52TaskReceipt(transaction([audit()]),
    "task-one", original, "advanced"), null);
});
