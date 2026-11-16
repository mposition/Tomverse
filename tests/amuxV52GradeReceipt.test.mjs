import assert from "node:assert/strict";
import test from "node:test";

import { calculateV4TaskCostCeiling } from "../lib/amux/v4TaskCostCeilingCore.ts";
import { AMUX_GRADE_ESCALATED_ACTION, amuxV52ApprovedCeilingInForce, readAmuxV52TaskReceipt } from
  "../lib/amux/v52GradeReceipt.ts";
import { AMUX_V4_TASK_CEILING_REAPPROVED_ACTION } from
  "../lib/amux/v4TaskCeilingReapprovalCore.ts";

const receipt = (grade, asOfIso = "2026-10-01T01:00:00.000Z") => {
  const result = calculateV4TaskCostCeiling({
    role: "implement", grade, catalogVersion: "catalog-v1",
    catalogDigest: "a".repeat(64), pricingVersion: "pricing-v1",
    gradeRulesVersion: "grade-v1", asOfIso,
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
const transaction = (rows, reapprovals = []) => ({ adminAuditLog: {
  findMany: async (query) => {
    if (query.where.action === AMUX_V4_TASK_CEILING_REAPPROVED_ACTION) {
      assert.deepEqual(query.where, { action: AMUX_V4_TASK_CEILING_REAPPROVED_ACTION,
        targetType: "AmuxWorkItem", targetId: "task-one" });
      assert.deepEqual(query.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
      assert.equal(query.take, 1);
      return reapprovals.slice(0, 1);
    }
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
  const tx = { adminAuditLog: { findMany: async (query) => {
    if (query.where.action === AMUX_V4_TASK_CEILING_REAPPROVED_ACTION) return [];
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

const raised = receipt("routine", "2026-11-14T01:00:00.000Z");
const reapproval = (overrides = {}) => ({ entryHash: "e".repeat(64), actorUserId: "owner-1",
  metadata: { confirmedReceiptDigest: original.receiptDigest,
    newReceiptDigest: raised.receiptDigest, newReceipt: raised, ...overrides } });

test("the owner's latest ceiling re-approval replaces the confirmation receipt", async () => {
  assert.deepEqual(await readAmuxV52TaskReceipt(transaction([], [reapproval()]),
    "task-one", original, "routine"), raised);
  // A latest entry that does not read holds the Task; it never falls back to
  // the lower receipt the owner replaced.
  for (const entry of [reapproval({ confirmedReceiptDigest: "d".repeat(64) }),
    { ...reapproval(), actorUserId: null }, reapproval({ newReceipt: { ...raised, ceilingMicroUsd: "1" } })])
    assert.equal(await readAmuxV52TaskReceipt(transaction([], [entry]),
      "task-one", original, "routine"), null);
});

test("a frontier escalation after a re-approval binds to the re-approved receipt", async () => {
  const afterReapproval = audit({ originalReceiptDigest: raised.receiptDigest });
  assert.deepEqual(await readAmuxV52TaskReceipt(transaction([afterReapproval], [reapproval()]),
    "task-one", original, "frontier"), escalated);
  // The escalation written against the confirmation no longer reads once a
  // re-approval replaced that receipt.
  assert.equal(await readAmuxV52TaskReceipt(transaction([audit()], [reapproval()]),
    "task-one", original, "frontier"), null);
  // A frontier re-approval after the escalation is the receipt in force.
  const frontier = receipt("frontier");
  assert.deepEqual(await readAmuxV52TaskReceipt(transaction([audit()], [reapproval({
    newReceipt: frontier, newReceiptDigest: frontier.receiptDigest })]),
  "task-one", original, "frontier"), frontier);
});

test("the Admin feedback ceiling is the receipt in force, unknown when it does not resolve", () => {
  const snapshot = (costReceipt) => ({ card: { task: { costReceipt } } });
  const ceiling = (input) => amuxV52ApprovedCeilingInForce({ confirmationSnapshot: snapshot(original),
    currentGrade: "routine", latestReapproval: null, escalations: [], ...input });
  // No replacing entry: read exactly as before.
  assert.equal(ceiling({}), BigInt(original.ceilingMicroUsd));
  assert.equal(ceiling({ confirmationSnapshot: null }), null);
  // The owner's re-approval is in force.
  assert.equal(ceiling({ latestReapproval: reapproval() }), BigInt(raised.ceilingMicroUsd));
  // A latest entry that does not read never shows the lower amount it replaced.
  assert.equal(ceiling({ latestReapproval: { ...reapproval(), actorUserId: null } }), null);
  // After a frontier escalation the frontier receipt is in force, also over a re-approval.
  assert.equal(ceiling({ currentGrade: "frontier", escalations: [audit()] }),
    BigInt(escalated.ceilingMicroUsd));
  assert.equal(ceiling({ currentGrade: "frontier", latestReapproval: reapproval(),
    escalations: [audit({ originalReceiptDigest: raised.receiptDigest })] }),
  BigInt(escalated.ceilingMicroUsd));
  // A re-approved routine ceiling is not shown once the Task runs at frontier
  // without an escalation bound to it.
  assert.equal(ceiling({ currentGrade: "frontier", latestReapproval: reapproval(),
    escalations: [audit()] }), null);
});
