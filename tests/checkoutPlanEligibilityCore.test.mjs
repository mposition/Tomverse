import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  CHECKOUT_PLAN_RANK,
  checkoutPlanEligibilityBlock,
} from "../lib/checkoutPlanEligibilityCore.ts";

/**
 * The three branches `docs/policy/plan-change.md` §5 keeps in
 * `/api/billing/checkout`.
 *
 * They are pinned here rather than only inside the route because a second
 * caller now reads them -- the Admin promotion diagnostics -- and the whole
 * reason to share the function is that the console cannot report an account as
 * ready for a checkout the server refuses. Relaxing any of these lets a plan
 * change be smuggled through the new-subscription Checkout, and one account
 * ends up paying for two plans at once.
 */

const block = (overrides = {}) =>
  checkoutPlanEligibilityBlock({
    effectivePlan: "Free",
    targetTier: "Pro",
    hasStripeSubscription: false,
    subscriptionStatus: null,
    ...overrides,
  });

test("a free account buying Pro is not blocked", () => {
  assert.equal(block(), null);
});

test("buying the plan the account already holds is refused", () => {
  const refusal = block({ effectivePlan: "Pro", targetTier: "Pro" });
  assert.equal(refusal.status, 409);
  assert.equal(refusal.code, "PLAN_CHANGE_NOT_SUPPORTED");
  assert.equal(refusal.reason, "same_plan");
  assert.equal(refusal.error, "This account is already on this plan.");
});

test("the same-plan refusal does not depend on a Stripe subscription", () => {
  // An account holding a plan by any other route -- an internal pass, an
  // operator grant -- must not be able to buy the plan it already has.
  assert.equal(
    block({
      effectivePlan: "Max",
      targetTier: "Max",
      hasStripeSubscription: false,
    }).reason,
    "same_plan"
  );
});

test("a downgrade is refused and points at account settings", () => {
  const refusal = block({ effectivePlan: "Max", targetTier: "Pro" });
  assert.equal(refusal.code, "PLAN_CHANGE_NOT_SUPPORTED");
  assert.equal(refusal.reason, "downgrade");
  assert.match(refusal.error, /lower plan/);
});

test("an upgrade with a live subscription is refused as an existing subscription", () => {
  for (const status of ACTIVE_SUBSCRIPTION_STATUSES) {
    const refusal = block({
      effectivePlan: "Pro",
      targetTier: "Max",
      hasStripeSubscription: true,
      subscriptionStatus: status,
    });
    assert.equal(refusal.code, "ACTIVE_SUBSCRIPTION_EXISTS", status);
    assert.equal(refusal.status, 409);
  }
});

test("a lapsed subscription does not block a fresh upgrade", () => {
  // `canceled`, `incomplete_expired` and the Founding Tester Pass status are
  // not live subscriptions; refusing them would strand the account.
  for (const status of ["canceled", "incomplete_expired", "unpaid", null]) {
    assert.equal(
      block({
        effectivePlan: "Pro",
        targetTier: "Max",
        hasStripeSubscription: true,
        subscriptionStatus: status,
      }),
      null,
      String(status)
    );
  }
});

test("a subscription id with no status, and a status with no id, are both inert", () => {
  assert.equal(
    block({
      effectivePlan: "Pro",
      targetTier: "Max",
      hasStripeSubscription: false,
      subscriptionStatus: "active",
    }),
    null
  );
  assert.equal(
    block({
      effectivePlan: "Pro",
      targetTier: "Max",
      hasStripeSubscription: true,
      subscriptionStatus: null,
    }),
    null
  );
});

test("same plan is checked before downgrade, and downgrade before subscription state", () => {
  // Order is part of the contract: an account on Max asking for Max with a
  // live subscription must read as "already on this plan", not as a
  // subscription conflict, or the CTA the client renders is the wrong one.
  assert.equal(
    block({
      effectivePlan: "Max",
      targetTier: "Max",
      hasStripeSubscription: true,
      subscriptionStatus: "active",
    }).reason,
    "same_plan"
  );
  assert.equal(
    block({
      effectivePlan: "Max",
      targetTier: "Pro",
      hasStripeSubscription: true,
      subscriptionStatus: "active",
    }).reason,
    "downgrade"
  );
});

test("plan ordering is total, so every pair has an answer", () => {
  assert.deepEqual(CHECKOUT_PLAN_RANK, { Free: 0, Pro: 1, Max: 2 });
});
