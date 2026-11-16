import assert from "node:assert/strict";
import test from "node:test";

import { calculateV4TaskCostCeiling, checkV4TaskApprovedCeiling } from "../lib/amux/v4TaskCostCeilingCore.ts";
import {
  AMUX_V4_TASK_CEILING_REAPPROVED_ACTION, amuxV4TaskCeilingReapprovalOffer,
  readAmuxV4TaskCeilingReapproval,
} from "../lib/amux/v4TaskCeilingReapprovalCore.ts";

const route = (id, modelId, outputPrice) => ({ routeId: id, workerName: `worker-${id}`,
  provider: "codex", modelId, routePolicyDigest: "b".repeat(64), enabled: true,
  roles: ["implement"], grades: ["advanced"], pricingSource: "verified-price-record",
  pricingVerifiedAt: "2026-10-01T00:00:00.000Z",
  uncachedInputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: outputPrice,
  cacheReadMicroUsdPerMillion: 100_000, cacheWriteMicroUsdPerMillion: 150_000,
  toolCostCapMicroUsdPerAttempt: 500 });

const receipt = (routes, asOfIso = "2026-10-01T01:00:00.000Z", grade = "advanced") => {
  const result = calculateV4TaskCostCeiling({
    role: "implement", grade, catalogVersion: "catalog-v1",
    catalogDigest: "a".repeat(64), pricingVersion: "pricing-v1",
    gradeRulesVersion: "grade-v1", asOfIso,
    caps: { uncachedInputTokens: 1000, outputTokens: 1000,
      cacheReadTokens: 500, cacheWriteTokens: 500, maxAttempts: 2 },
    routes: routes.map((item) => ({ ...item, grades: [grade] })),
  });
  assert.equal(result.ok, true);
  return result.receipt;
};

const approved = receipt([route("a", "model-a", 2_000_000)]);
// A worker on a model the registration did not name, priced above the ceiling.
const current = receipt([route("a", "model-a", 2_000_000), route("b", "model-b", 9_000_000)],
  "2026-11-14T01:00:00.000Z");

const waiting = { v4Task: true, status: "backlog", liveAttempt: false, activeDelivery: false,
  role: "implement", grade: "advanced", approved, current };

test("a waiting Task priced above its receipt is offered the current receipt", () => {
  assert.equal(checkV4TaskApprovedCeiling(approved, { ok: true, receipt: current }).decision, "reconfirm");
  const offer = amuxV4TaskCeilingReapprovalOffer(waiting);
  assert.equal(offer.eligible, true);
  assert.equal(offer.reason, "task_route_changed");
  assert.equal(offer.current, current);
  assert.ok(BigInt(offer.current.ceilingMicroUsd) > BigInt(approved.ceilingMicroUsd));
  for (const status of ["todo", "blocked"])
    assert.equal(amuxV4TaskCeilingReapprovalOffer({ ...waiting, status }).eligible, true);
});

test("every other Task is refused with its reason", () => {
  const cases = [
    [{ v4Task: false }, "not_v4_task"],
    [{ role: null }, "not_v4_task"],
    [{ status: "in_progress" }, "not_waiting"],
    [{ status: "review" }, "not_waiting"],
    [{ status: "done" }, "not_waiting"],
    [{ liveAttempt: true }, "attempt_live"],
    [{ activeDelivery: true }, "attempt_live"],
    [{ approved: null }, "approval_invalid"],
    [{ current: null }, "cost_unavailable"],
    [{ role: "review" }, "role_or_grade_changed"],
    [{ grade: "frontier" }, "role_or_grade_changed"],
    [{ current: approved }, "within_approved_ceiling"],
    [{ approved: { ...approved, receiptDigest: "f".repeat(64) } }, "approval_invalid"],
  ];
  for (const [override, refusal] of cases) {
    const offer = amuxV4TaskCeilingReapprovalOffer({ ...waiting, ...override });
    assert.equal(offer.eligible, false, refusal);
    assert.equal(offer.refusal, refusal);
  }
});

const row = (overrides = {}, metadata = {}) => ({ entryHash: "c".repeat(64), actorUserId: "owner-1",
  metadata: { confirmedReceiptDigest: approved.receiptDigest, newReceiptDigest: current.receiptDigest,
    newReceipt: current, ...metadata }, ...overrides });

test("a person's entry bound to the confirmation puts its receipt in force", () => {
  assert.equal(AMUX_V4_TASK_CEILING_REAPPROVED_ACTION, "amux.task.ceiling_reapproved");
  assert.deepEqual(readAmuxV4TaskCeilingReapproval(row(), approved), current);
});

test("an entry that is not the owner's binding never reads", () => {
  const other = receipt([route("c", "model-c", 2_000_000)]);
  for (const entry of [
    row({ entryHash: null }), row({ actorUserId: null }), row({ metadata: null }),
    row({ metadata: [] }),
    row({}, { confirmedReceiptDigest: other.receiptDigest }),
    row({}, { newReceiptDigest: approved.receiptDigest }),
    row({}, { newReceipt: { ...current, ceilingMicroUsd: "1" } }),
    row({}, { newReceipt: { ...current, role: "review" }, newReceiptDigest: current.receiptDigest }),
  ]) assert.equal(readAmuxV4TaskCeilingReapproval(entry, approved), null);
  // A whole receipt for another role, even with its own digest, never reads.
  const review = calculateV4TaskCostCeiling({ ...{
    role: "review", grade: "advanced", catalogVersion: "catalog-v1",
    catalogDigest: "a".repeat(64), pricingVersion: "pricing-v1",
    gradeRulesVersion: "grade-v1", asOfIso: "2026-11-14T01:00:00.000Z",
    caps: { uncachedInputTokens: 1000, outputTokens: 1000,
      cacheReadTokens: 500, cacheWriteTokens: 500, maxAttempts: 2 },
    routes: [{ ...route("r", "model-r", 2_000_000), roles: ["review"] }] } });
  assert.equal(review.ok, true);
  assert.equal(readAmuxV4TaskCeilingReapproval(row({}, { newReceipt: review.receipt,
    newReceiptDigest: review.receipt.receiptDigest }), approved), null);
});
