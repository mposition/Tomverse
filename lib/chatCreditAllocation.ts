export type ChatCreditAllocationInput = {
  requiredCredits: number;
  monthlyPlanCreditsRemaining: number;
  dailyPlanCreditsRemaining: number | null;
  purchasedCreditsRemaining: number;
};

const asCreditAmount = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/**
 * Splits a request between plan credits and purchased credits.
 *
 * The daily guardrail applies only to plan credits. Purchased credits remain
 * usable after that guardrail is reached, while monthly plan credits stay
 * available for the next account-local day.
 */
export const getChatCreditAllocation = ({
  requiredCredits,
  monthlyPlanCreditsRemaining,
  dailyPlanCreditsRemaining,
  purchasedCreditsRemaining,
}: ChatCreditAllocationInput) => {
  const required = asCreditAmount(requiredCredits);
  const monthlyPlan = asCreditAmount(monthlyPlanCreditsRemaining);
  const purchased = asCreditAmount(purchasedCreditsRemaining);
  const dailyPlan =
    dailyPlanCreditsRemaining === null
      ? null
      : asCreditAmount(dailyPlanCreditsRemaining);
  const planCreditsAvailableNow = Math.min(
    monthlyPlan,
    dailyPlan === null ? monthlyPlan : dailyPlan
  );
  const planReservedCredits = Math.min(required, planCreditsAvailableNow);
  const addOnCreditsRequired = Math.max(0, required - planReservedCredits);
  const totalAccountCredits = monthlyPlan + purchased;
  const totalCreditsAvailableNow = planCreditsAvailableNow + purchased;
  const balanceInsufficient = required > totalAccountCredits;
  const dailyPlanGuardrailBlocked =
    !balanceInsufficient && required > totalCreditsAvailableNow;

  return {
    requiredCredits: required,
    monthlyPlanCreditsRemaining: monthlyPlan,
    dailyPlanCreditsRemaining: dailyPlan,
    purchasedCreditsRemaining: purchased,
    planCreditsAvailableNow,
    planReservedCredits,
    addOnCreditsRequired,
    totalAccountCredits,
    totalCreditsAvailableNow,
    balanceInsufficient,
    dailyPlanGuardrailBlocked,
  };
};
