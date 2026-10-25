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

export const STORE_ENTITLEMENT_SELECT = {
  webSubscriptionPlan: true, storeSubscriptionPlan: true, storeSubscriptionExpiresAt: true,
} as const;

export const effectivePlanForAccess = (
  input: {
    plan: unknown;
    subscriptionStatus?: string | null;
    subscriptionCurrentPeriodEnd?: Date | string | null;
    webSubscriptionPlan?: string | null;
    storeSubscriptionPlan?: string | null;
    storeSubscriptionExpiresAt?: Date | string | null;
  },
  now = new Date()
): EffectivePlanTier => {
  let plan = normalizePlan(input.webSubscriptionPlan ?? input.plan);
  const expiringAccess = input.subscriptionStatus === FOUNDING_TESTER_PASS_STATUS || input.subscriptionStatus?.startsWith("mobile_store_");
  if (expiringAccess) {
    const periodEnd = new Date(input.subscriptionCurrentPeriodEnd || 0);
    if (!Number.isFinite(periodEnd.getTime()) || periodEnd <= now) plan = "Free";
  }
  const storeExpiry = new Date(input.storeSubscriptionExpiresAt || 0);
  const native = Number.isFinite(storeExpiry.getTime()) && storeExpiry > now ? normalizePlan(input.storeSubscriptionPlan) : "Free";
  if (native === "Max" || plan === "Max") return "Max";
  if (native === "Pro" || plan === "Pro") return "Pro";
  return plan;
};

export const isInternalPassPromotion = (promotion: {
  fulfillmentType?: string | null;
}) => promotion.fulfillmentType === INTERNAL_PASS_FULFILLMENT;
