import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_USER_SEGMENTS,
  normalizeAdminUserSegment,
} from "../lib/adminUserTypes.ts";
import { adminUsersCsv } from "../lib/adminUsersCsv.ts";

test("admin user segments reject unknown client values", () => {
  assert.equal(normalizeAdminUserSegment("activePaid"), "activePaid");
  assert.equal(normalizeAdminUserSegment("paid"), "all");
  assert.equal(normalizeAdminUserSegment("anything-else"), "all");
  assert.deepEqual(ADMIN_USER_SEGMENTS.slice(0, 4), ["all", "free", "pro", "max"]);
});

test("admin user CSV neutralizes spreadsheet formulas and includes audit fields", () => {
  const csv = adminUsersCsv([
    {
      id: "user-1",
      email: "=IMPORTXML(\"https://example.test\")",
      name: "+cmd",
      plan: "Pro",
      createdAt: "2026-07-16T00:00:00.000Z",
      subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: "2026-08-16T00:00:00.000Z",
      subscriptionBillingInterval: "monthly",
      subscriptionCancelAtPeriodEnd: false,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      usageToday: 4,
      creditDebtCredits: 0,
      creditDebtCostMicroUsd: 0,
      billingRiskStatus: "normal",
      _count: {
        conversations: 2,
        accounts: 1,
        refundRequests: 0,
        promotionRedemptions: 0,
      },
    },
  ]);

  assert.match(csv, /"'=IMPORTXML\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /"'\+cmd"/);
  assert.match(csv, /"billingRiskStatus"/);
  assert.match(csv, /"usageToday"/);
});
