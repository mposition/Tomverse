import assert from "node:assert/strict";
import test from "node:test";
import { planCreditsAfterPlanChange } from "../lib/planChangeCredits.ts";

test("an upgrade swaps the allowance without resetting the month's usage", () => {
  // The worked example from the approved policy: Pro spent 2,500 this month,
  // upgrades to Max, and is left with Max's allowance minus what was spent.
  const outcome = planCreditsAfterPlanChange({
    newMonthlyPlanCredits: 10_000,
    planCreditsUsedThisMonth: 2_500,
  });

  assert.equal(outcome.remainingPlanCredits, 7_500);
  assert.equal(outcome.overageCredits, 0);
  // Usage is carried, not cleared -- clearing it would hand out the spent
  // credits a second time.
  assert.equal(outcome.planCreditsUsedThisMonth, 2_500);
});

test("an upgrade grants no second allowance on top of what was already used", () => {
  const outcome = planCreditsAfterPlanChange({
    newMonthlyPlanCredits: 10_000,
    planCreditsUsedThisMonth: 0,
  });

  // 10,000, not 3,000 + 10,000: the plan's allowance replaces the old one.
  assert.equal(outcome.remainingPlanCredits, 10_000);
});

test("a downgrade cannot claw back credits or leave the account in debt", () => {
  // Max account spent 6,000 this month, then lands on Pro's 3,000 allowance.
  const outcome = planCreditsAfterPlanChange({
    newMonthlyPlanCredits: 3_000,
    planCreditsUsedThisMonth: 6_000,
  });

  assert.equal(outcome.remainingPlanCredits, 0);
  // Reported so a preview can say "0 until the reset" instead of implying a
  // balance -- but it is never charged back.
  assert.equal(outcome.overageCredits, 3_000);
});

test("a mid-month downgrade leaves the remainder of the lower allowance", () => {
  // The policy's Max -> Pro formula: max(0, 3,000 - usage this UTC month).
  const outcome = planCreditsAfterPlanChange({
    newMonthlyPlanCredits: 3_000,
    planCreditsUsedThisMonth: 1_200,
  });

  assert.equal(outcome.remainingPlanCredits, 1_800);
  assert.equal(outcome.overageCredits, 0);
});

test("a plan change is not a debt amnesty", () => {
  // Debt is subtracted exactly as the steady-state balance subtracts it, so an
  // upgrade cannot be used to wipe an outstanding balance.
  const outcome = planCreditsAfterPlanChange({
    newMonthlyPlanCredits: 10_000,
    planCreditsUsedThisMonth: 2_500,
    creditDebtCredits: 500,
  });

  assert.equal(outcome.remainingPlanCredits, 7_000);
});

test("both directions are the same rule with a different allowance", () => {
  // Not a stylistic point: two formulas would be two places for the boundary
  // behaviour to drift. Upgrading then immediately downgrading has to land on
  // the same number as never having upgraded.
  const used = 2_500;
  const upgraded = planCreditsAfterPlanChange({
    newMonthlyPlanCredits: 10_000,
    planCreditsUsedThisMonth: used,
  });
  const backDown = planCreditsAfterPlanChange({
    newMonthlyPlanCredits: 3_000,
    planCreditsUsedThisMonth: used,
  });
  const neverChanged = planCreditsAfterPlanChange({
    newMonthlyPlanCredits: 3_000,
    planCreditsUsedThisMonth: used,
  });

  assert.equal(upgraded.remainingPlanCredits, 7_500);
  assert.deepEqual(backDown, neverChanged);
});

test("a fresh UTC month resets to the new plan's full allowance", () => {
  // Nothing special happens at the boundary: usage is zero, so the account
  // simply gets the plan it is on.
  assert.equal(
    planCreditsAfterPlanChange({
      newMonthlyPlanCredits: 10_000,
      planCreditsUsedThisMonth: 0,
    }).remainingPlanCredits,
    10_000
  );
  assert.equal(
    planCreditsAfterPlanChange({
      newMonthlyPlanCredits: 3_000,
      planCreditsUsedThisMonth: 0,
    }).remainingPlanCredits,
    3_000
  );
});

test("nonsense inputs clamp instead of producing a negative or fractional balance", () => {
  const outcome = planCreditsAfterPlanChange({
    newMonthlyPlanCredits: Number.NaN,
    planCreditsUsedThisMonth: -50,
    creditDebtCredits: Number.POSITIVE_INFINITY,
  });

  assert.equal(outcome.monthlyPlanCredits, 0);
  assert.equal(outcome.planCreditsUsedThisMonth, 0);
  assert.equal(outcome.creditDebtCredits, 0);
  assert.equal(outcome.remainingPlanCredits, 0);

  assert.equal(
    planCreditsAfterPlanChange({
      newMonthlyPlanCredits: 10_000.9,
      planCreditsUsedThisMonth: 2_500.4,
    }).remainingPlanCredits,
    7_500
  );
});
