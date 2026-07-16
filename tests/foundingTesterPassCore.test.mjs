import assert from "node:assert/strict";
import test from "node:test";
import {
  FOUNDING_TESTER_PASS_STATUS,
  addUtcDays,
  effectivePlanForAccess,
  isInternalPassPromotion,
} from "../lib/foundingTesterPassCore.ts";

test("Founding Tester Pass lasts exactly the configured number of days", () => {
  const start = new Date("2026-07-16T03:12:45.000Z");
  assert.equal(addUtcDays(start, 60).toISOString(), "2026-09-14T03:12:45.000Z");
});

test("expired internal passes resolve to Free before maintenance runs", () => {
  const now = new Date("2026-09-15T00:00:00.000Z");
  assert.equal(
    effectivePlanForAccess(
      {
        plan: "Pro",
        subscriptionStatus: FOUNDING_TESTER_PASS_STATUS,
        subscriptionCurrentPeriodEnd: "2026-09-14T00:00:00.000Z",
      },
      now
    ),
    "Free"
  );
});

test("active internal passes keep Pro access and require explicit fulfillment", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  assert.equal(
    effectivePlanForAccess(
      {
        plan: "Pro",
        subscriptionStatus: FOUNDING_TESTER_PASS_STATUS,
        subscriptionCurrentPeriodEnd: "2026-09-14T00:00:00.000Z",
      },
      now
    ),
    "Pro"
  );
  assert.equal(isInternalPassPromotion({ fulfillmentType: "internal_pass" }), true);
  assert.equal(
    isInternalPassPromotion({ fulfillmentType: "stripe_subscription" }),
    false
  );
});
