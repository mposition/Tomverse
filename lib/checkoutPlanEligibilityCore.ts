/**
 * The three account-state branches that refuse a subscription Checkout, as one
 * pure function.
 *
 * These branches are policy, not implementation detail: `docs/policy/plan-change.md`
 * §5 keeps them precisely so a Pro <-> Max change cannot be smuggled through
 * the new-subscription Checkout and leave one account paying for two plans.
 * They stay where they are and say what they said.
 *
 * They are extracted here because a second reader appeared. The Admin promotion
 * diagnostics has to answer "would this account's checkout be refused before
 * the promotion is even reached", and answering it with a second copy of the
 * comparison is how the console starts reporting `ready` for a checkout the
 * server refuses -- the exact failure that made a diagnostics tool worth
 * building. One function, two callers, no room to disagree.
 *
 * Nothing here reads Stripe, Prisma or a clock. The caller resolves the
 * account's *effective* plan first (`effectivePlanForAccess`), because a lapsed
 * Founding Tester Pass still leaves `User.plan` at "Pro" and blocking that
 * account from subscribing would be wrong.
 */

export type CheckoutPlanTier = "Free" | "Pro" | "Max";

/**
 * Plan ordering, so "same plan, upgrade or downgrade" is one comparison rather
 * than a chain of plan-name conditionals.
 */
export const CHECKOUT_PLAN_RANK: Record<CheckoutPlanTier, number> = {
  Free: 0,
  Pro: 1,
  Max: 2,
};

/** Subscription states Stripe considers live enough to block a second one. */
export const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
]);

export type CheckoutPlanBlockReason =
  | "same_plan"
  | "downgrade"
  | "active_subscription";

export type CheckoutPlanBlock = {
  reason: CheckoutPlanBlockReason;
  status: 409;
  code: "PLAN_CHANGE_NOT_SUPPORTED" | "ACTIVE_SUBSCRIPTION_EXISTS";
  error: string;
};

export type CheckoutPlanEligibilityInput = {
  /** The plan the account can actually use right now, not the raw column. */
  effectivePlan: CheckoutPlanTier;
  /** The tier the requested plan maps to. */
  targetTier: CheckoutPlanTier;
  /** Whether a Stripe subscription id is stored against the account. */
  hasStripeSubscription: boolean;
  subscriptionStatus?: string | null;
};

export const checkoutPlanEligibilityBlock = ({
  effectivePlan,
  targetTier,
  hasStripeSubscription,
  subscriptionStatus,
}: CheckoutPlanEligibilityInput): CheckoutPlanBlock | null => {
  // Same plan. Checked on the effective plan rather than on a Stripe
  // subscription being attached, so an account holding a plan by any other
  // route cannot buy the plan it already has.
  if (effectivePlan === targetTier) {
    return {
      reason: "same_plan",
      status: 409,
      code: "PLAN_CHANGE_NOT_SUPPORTED",
      error: "This account is already on this plan.",
    };
  }

  // A downgrade. Creating a second, cheaper subscription here would leave the
  // account paying for two plans at once; downgrades run through the dedicated
  // plan-change endpoint, which manages a Subscription Schedule.
  if (CHECKOUT_PLAN_RANK[effectivePlan] > CHECKOUT_PLAN_RANK[targetTier]) {
    return {
      reason: "downgrade",
      status: 409,
      code: "PLAN_CHANGE_NOT_SUPPORTED",
      error:
        "Moving to a lower plan is handled from account settings at the end of the paid period.",
    };
  }

  // An upgrade while a Stripe subscription is live is a *change* to that
  // subscription, which this endpoint does not perform. The UI resolves this
  // state to "manage_plan" (see resolvePlanCtaState in lib/purchaseIntent.ts);
  // the code lets a client that arrives anyway say so precisely.
  if (
    hasStripeSubscription &&
    subscriptionStatus &&
    ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus)
  ) {
    return {
      reason: "active_subscription",
      status: 409,
      code: "ACTIVE_SUBSCRIPTION_EXISTS",
      error: "An active subscription already exists.",
    };
  }

  return null;
};
