export const INTERNAL_PASS_FULFILLMENT = "internal_pass" as const;
export const STRIPE_SUBSCRIPTION_FULFILLMENT =
  "stripe_subscription" as const;
export const FOUNDING_TESTER_PASS_STATUS = "founding_tester_pass" as const;
export const FOUNDING_TESTER_PASS_EXPIRED_STATUS =
  "founding_tester_pass_expired" as const;

export type EffectivePlanTier = "Free" | "Pro" | "Max";

export const addUtcDays = (date: Date, days: number) => {
  if (!Number.isSafeInteger(days) || days <= 0 || days > 366) {
    throw new Error("Internal pass duration must be between 1 and 366 days.");
  }
  return new Date(date.getTime() + days * 86_400_000);
};

const normalizePlan = (value: unknown): EffectivePlanTier =>
  value === "Pro" || value === "Max" ? value : "Free";

export const effectivePlanForAccess = (
  input: {
    plan: unknown;
    subscriptionStatus?: string | null;
    subscriptionCurrentPeriodEnd?: Date | string | null;
  },
  now = new Date()
): EffectivePlanTier => {
  const plan = normalizePlan(input.plan);
  if (input.subscriptionStatus !== FOUNDING_TESTER_PASS_STATUS) return plan;
  if (!input.subscriptionCurrentPeriodEnd) return "Free";
  const periodEnd = new Date(input.subscriptionCurrentPeriodEnd);
  if (!Number.isFinite(periodEnd.getTime()) || periodEnd <= now) return "Free";
  return plan;
};

export const isInternalPassPromotion = (promotion: {
  fulfillmentType?: string | null;
}) => promotion.fulfillmentType === INTERNAL_PASS_FULFILLMENT;
