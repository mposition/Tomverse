/**
 * What a plan change does to the current month's plan credits.
 *
 * The approved policy (docs/policy/plan-change.md) is deliberately one rule in
 * both directions: a plan change swaps the monthly allowance and leaves the
 * month's usage alone. Nothing is reset, nothing is granted on top, and nothing
 * already spent is clawed back.
 *
 *     remaining = max(0, newMonthlyPlanCredits - usedThisMonth - creditDebt)
 *
 * That is the same shape `/api/user/usage` already uses for the steady state,
 * which is the point: after a change the account's remaining balance is
 * computed exactly as it would have been had it always been on the new plan
 * this month. There is no separate "just upgraded" accounting to drift.
 *
 * Two consequences are accepted on purpose rather than worked around:
 *
 *   - **The whole new allowance applies to the current month**, regardless of
 *     what Stripe prorated in money terms. A Pro account that has spent 2,500
 *     credits and upgrades mid-month gets 7,500 remaining, not a fraction of
 *     Max's 10,000. Simple to explain, simple to verify, and generous in the
 *     customer's favour.
 *   - **A downgrade cannot create debt.** If a Max account spent 6,000 credits
 *     and lands on Pro's 3,000 allowance, the clamp yields 0 remaining -- not
 *     -3,000, and not a debit against next month. Credits already spent were
 *     legitimately earned by the plan that was active at the time.
 *
 * This module is pure so the same arithmetic can be asserted in unit tests, run
 * in the change endpoint, and quoted to the customer in a preview, without
 * three implementations that disagree at the boundaries.
 */

export type PlanChangeCreditInput = {
  /** The monthly plan allowance of the plan being moved *to*. */
  newMonthlyPlanCredits: number;
  /**
   * Plan credits already consumed in the current UTC month. Purchased credits
   * are not part of this: they are a separate balance with their own expiry and
   * are untouched by a plan change.
   */
  planCreditsUsedThisMonth: number;
  /**
   * Unrecovered credit debt, subtracted the same way the steady-state balance
   * subtracts it. A plan change is not a debt amnesty.
   */
  creditDebtCredits?: number;
};

export type PlanChangeCreditOutcome = {
  monthlyPlanCredits: number;
  planCreditsUsedThisMonth: number;
  creditDebtCredits: number;
  /** Plan credits usable for the remainder of the current UTC month. */
  remainingPlanCredits: number;
  /**
   * How far past the new allowance the month's usage already went. Non-zero
   * only on a downgrade, and never charged back -- it exists so a preview can
   * say "0 remaining until the reset" honestly instead of implying a balance.
   */
  overageCredits: number;
};

const asCreditAmount = (value: number | undefined) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;

export const planCreditsAfterPlanChange = ({
  newMonthlyPlanCredits,
  planCreditsUsedThisMonth,
  creditDebtCredits,
}: PlanChangeCreditInput): PlanChangeCreditOutcome => {
  const monthlyPlanCredits = asCreditAmount(newMonthlyPlanCredits);
  const used = asCreditAmount(planCreditsUsedThisMonth);
  const debt = asCreditAmount(creditDebtCredits);
  const net = monthlyPlanCredits - used - debt;

  return {
    monthlyPlanCredits,
    planCreditsUsedThisMonth: used,
    creditDebtCredits: debt,
    remainingPlanCredits: Math.max(0, net),
    overageCredits: Math.max(0, -net),
  };
};
