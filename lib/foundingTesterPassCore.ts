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
  storeSubscriptionSnapshot: true,
} as const;

export const effectivePlanForAccess = (
  input: {
    plan: unknown;
    subscriptionStatus?: string | null;
    subscriptionCurrentPeriodEnd?: Date | string | null;
    webSubscriptionPlan?: string | null;
    storeSubscriptionPlan?: string | null;
    storeSubscriptionExpiresAt?: Date | string | null;
    storeSubscriptionSnapshot?: unknown;
  },
  now = new Date()
): EffectivePlanTier => {
  const hasStoreHistory = normalizePlan(input.storeSubscriptionPlan) !== "Free" ||
    (Array.isArray(input.storeSubscriptionSnapshot) && input.storeSubscriptionSnapshot.slice(0, 30).some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as { plan?: unknown; store?: unknown; expiresAt?: unknown };
      return normalizePlan(item.plan) !== "Free" && (item.store === "app_store" || item.store === "play_store") &&
        typeof item.expiresAt === "string" && Number.isFinite(Date.parse(item.expiresAt));
    }));
  // Before store activation, old and new application versions may both write
  // web plans during rollout. The original column stays authoritative there.
  let plan = normalizePlan(hasStoreHistory ? input.webSubscriptionPlan ?? input.plan : input.plan);
  const expiringAccess = input.subscriptionStatus === FOUNDING_TESTER_PASS_STATUS || input.subscriptionStatus?.startsWith("mobile_store_");
  if (expiringAccess) {
    const periodEnd = new Date(input.subscriptionCurrentPeriodEnd || 0);
    if (!Number.isFinite(periodEnd.getTime()) || periodEnd <= now) plan = "Free";
  }
  const storeExpiry = new Date(input.storeSubscriptionExpiresAt || 0);
  let native = Number.isFinite(storeExpiry.getTime()) && storeExpiry > now ? normalizePlan(input.storeSubscriptionPlan) : "Free";
  // Preserve every verified store period, including a lower tier that outlives
  // an overlapping higher tier on the other store.
  if (Array.isArray(input.storeSubscriptionSnapshot)) for (const entry of input.storeSubscriptionSnapshot.slice(0, 30)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { store?: unknown; plan?: unknown; expiresAt?: unknown };
    if ((item.store !== "app_store" && item.store !== "play_store") || typeof item.expiresAt !== "string" || new Date(item.expiresAt) <= now || !Number.isFinite(Date.parse(item.expiresAt))) continue;
    const tier = normalizePlan(item.plan);
    if (tier === "Max" || (tier === "Pro" && native === "Free")) native = tier;
  }
  if (native === "Max" || plan === "Max") return "Max";
  if (native === "Pro" || plan === "Pro") return "Pro";
  return plan;
};

export const isInternalPassPromotion = (promotion: {
  fulfillmentType?: string | null;
}) => promotion.fulfillmentType === INTERNAL_PASS_FULFILLMENT;
