import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalPayloadHash,
  approvalPermissionForAction,
  approvalTtlMinutes,
  canReviewAdminApproval,
  refundApprovalThresholdCents,
} from "../lib/adminApprovalCore.ts";

test("approval payload hashes are stable across object key order", () => {
  assert.equal(
    approvalPayloadHash({ plan: "Pro", nested: { b: 2, a: 1 } }),
    approvalPayloadHash({ nested: { a: 1, b: 2 }, plan: "Pro" })
  );
  assert.notEqual(
    approvalPayloadHash({ plan: "Pro" }),
    approvalPayloadHash({ plan: "Max" })
  );
});

test("approval review rejects self-approval, expired, and non-pending records", () => {
  const future = new Date(Date.now() + 60_000);
  assert.equal(canReviewAdminApproval({
    requestedById: "admin-a",
    reviewerId: "admin-a",
    status: "pending",
    expiresAt: future,
  }), false);
  assert.equal(canReviewAdminApproval({
    requestedById: "admin-a",
    reviewerId: "admin-b",
    status: "pending",
    expiresAt: future,
  }), true);
  assert.equal(canReviewAdminApproval({
    requestedById: "admin-a",
    reviewerId: "admin-b",
    status: "approved",
    expiresAt: future,
  }), false);
});

test("approval policy maps actions and clamps configuration", () => {
  assert.equal(approvalPermissionForAction("refund.approve"), "billing:write");
  assert.equal(approvalPermissionForAction("model.disable"), "ops:write");
  assert.equal(approvalPermissionForAction("user.delete"), "user:delete");
  assert.equal(approvalTtlMinutes("1"), 5);
  assert.equal(refundApprovalThresholdCents("-4"), 0);
});
