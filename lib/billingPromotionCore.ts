import type { BillingCurrency } from "@/lib/billingMarkets";

export type PromotionValidationReason =
  | "invalid"
  | "unavailable"
  | "not_started"
  | "expired"
  | "redemption_limit"
  | "plan_not_eligible"
  | "annual_not_allowed"
  | "currency_not_supported"
  | "already_used";

/**
 * The billing currencies a fixed-amount promotion can be charged in.
 *
 * `BillingPromotion.discountAmountCents` is a USD amount and nothing in the
 * schema says otherwise, so USD is the only currency in which the stored number
 * means what it says. Charging it against A$20.00 would be subtracting fourteen
 * of one currency from twenty of another.
 *
 * Widening this is a product and finance decision, not a code change: it needs
 * per-currency discount amounts, an admin surface that captures them, Stripe
 * coupon `currency_options` provisioning and reconciliation, and a webhook
 * amount check that knows about both. Until then the honest answer to "can this
 * code be used here" is no, given early enough that nobody is shown a price
 * that will not be charged.
 */
export const FIXED_AMOUNT_PROMOTION_CURRENCIES: readonly BillingCurrency[] = [
  "USD",
];

type PromotionCurrencyInput = {
  discountPercent: number;
  discountAmountCents: number | null;
  fulfillmentType?: string | null;
};

/**
 * Whether this promotion discounts a fixed USD amount rather than a percentage.
 *
 * One definition, because two places decide from it and they must not disagree:
 * `promotionCurrencyFailure()` refuses these outside USD, and the Admin policy
 * in `lib/billingPromotionAdminPolicy.ts` refuses creating any more of them.
 * A promotion carrying both a percent and an amount is a percentage promotion
 * -- `promotionDiscountedMinor()` applies the percent and ignores the amount,
 * so that is what the customer is actually charged.
 */
export const isFixedAmountPromotion = (promotion: {
  discountPercent: number;
  discountAmountCents: number | null;
}) =>
  promotion.discountPercent <= 0 && (promotion.discountAmountCents || 0) > 0;

/**
 * Whether this promotion can be charged in this currency.
 *
 * Pure, and the only place the rule lives. It used to exist as an inline
 * refusal inside the checkout route, which is why validation could return
 * `valid: true` for an AUD checkout that the button would then reject: the
 * order summary was built from an answer nothing had asked the currency
 * question of.
 *
 * A percentage applies to whatever the local price is, so it is allowed
 * everywhere. An internal pass never becomes a Stripe coupon at all -- it is
 * fulfilled by granting an access period -- so the rule does not apply to it.
 */
export const promotionCurrencyFailure = ({
  promotion,
  currency,
}: {
  promotion: PromotionCurrencyInput;
  currency: BillingCurrency;
}): "currency_not_supported" | null => {
  if (promotion.fulfillmentType === "internal_pass") return null;
  // Not a fixed-amount promotion: a percentage applies to whatever the local
  // price is, and a promotion that discounts nothing is already refused by
  // `promotionEligibilityFailure()` -- answering "currency" here would relabel
  // that failure.
  if (!isFixedAmountPromotion(promotion)) return null;
  return FIXED_AMOUNT_PROMOTION_CURRENCIES.includes(currency)
    ? null
    : "currency_not_supported";
};

type PromotionEligibilityInput = {
  isActive: boolean;
  maxRedemptions: number | null;
  redeemedCount: number;
  startsAt: string | null;
  endsAt: string | null;
  appliesToPlanIds: string[];
  allowAnnualStacking: boolean;
  discountPercent: number;
  discountAmountCents: number | null;
  fulfillmentType?: string | null;
  accessDurationDays?: number | null;
};

export const promotionEligibilityFailure = ({
  promotion,
  planId,
  billingInterval,
  now = new Date(),
}: {
  promotion: PromotionEligibilityInput;
  planId?: string;
  billingInterval?: "monthly" | "annual";
  now?: Date;
}): Exclude<PromotionValidationReason, "invalid" | "already_used"> | null => {
  if (!promotion.isActive || !promotion.maxRedemptions || !promotion.endsAt) {
    return "unavailable";
  }
  if (promotion.startsAt && new Date(promotion.startsAt) > now) {
    return "not_started";
  }
  if (new Date(promotion.endsAt) <= now) return "expired";
  if (promotion.redeemedCount >= promotion.maxRedemptions) {
    return "redemption_limit";
  }
  if (
    promotion.discountPercent <= 0 &&
    !(promotion.discountAmountCents && promotion.discountAmountCents > 0)
  ) {
    return "unavailable";
  }
  if (
    promotion.fulfillmentType === "internal_pass" &&
    (promotion.discountPercent !== 100 ||
      !Number.isSafeInteger(promotion.accessDurationDays) ||
      (promotion.accessDurationDays || 0) <= 0 ||
      (promotion.accessDurationDays || 0) > 366)
  ) {
    return "unavailable";
  }
  if (planId && !promotion.appliesToPlanIds.includes(planId)) {
    return "plan_not_eligible";
  }
  if (billingInterval === "annual" && !promotion.allowAnnualStacking) {
    return "annual_not_allowed";
  }
  return null;
};

/**
 * The amount a promotion leaves to charge, in the currency's minor unit.
 *
 * Lives here rather than in the checkout route because the Admin promotion
 * diagnostics quotes the same number without creating a Session. Two copies of
 * a rounding rule is two answers to "what will the customer be charged", and
 * the whole point of the preview is that it matches.
 */
export const promotionDiscountedMinor = (
  amountMinor: number,
  promotion: {
    discountPercent: number;
    discountAmountCents: number | null;
  } | null
) => {
  if (!promotion) return amountMinor;
  if (promotion.discountPercent > 0) {
    return Math.max(
      0,
      Math.round(amountMinor * (1 - promotion.discountPercent / 100))
    );
  }
  return Math.max(0, amountMinor - (promotion.discountAmountCents || 0));
};

export const promotionValidationError = (reason: PromotionValidationReason) => {
  switch (reason) {
    case "already_used":
      return {
        status: 409,
        code: "PROMOTION_ALREADY_USED",
        message: "This promotion code has already been used by this account.",
      };
    case "not_started":
      return {
        status: 400,
        code: "PROMOTION_NOT_STARTED",
        message: "This promotion has not started yet.",
      };
    case "expired":
      return {
        status: 409,
        code: "PROMOTION_EXPIRED",
        message: "This promotion has expired.",
      };
    case "redemption_limit":
      return {
        status: 409,
        code: "PROMOTION_REDEMPTION_LIMIT_REACHED",
        message: "This promotion has reached its redemption limit.",
      };
    case "plan_not_eligible":
      return {
        status: 400,
        code: "PROMOTION_PLAN_NOT_ELIGIBLE",
        message: "This promotion is not available for the selected plan.",
      };
    case "annual_not_allowed":
      return {
        status: 400,
        code: "PROMOTION_ANNUAL_NOT_ALLOWED",
        message: "This promotion can only be used with monthly billing.",
      };
    case "currency_not_supported":
      // Its own code rather than PROMOTION_UNAVAILABLE: this one has an action
      // attached to it -- use a percentage code -- and the client localises by
      // code. Folding it into the generic refusal would leave the customer with
      // "not currently available" for a code that is available, just not here.
      return {
        status: 400,
        code: "PROMOTION_CURRENCY_NOT_SUPPORTED",
        message:
          "Fixed-amount promotion codes are currently available only for USD checkout. Use a percentage promotion for localized billing.",
      };
    case "unavailable":
      return {
        status: 400,
        code: "PROMOTION_UNAVAILABLE",
        message: "This promotion is not currently available.",
      };
    default:
      return {
        status: 400,
        code: "PROMOTION_INVALID",
        message: "Invalid promotion code.",
      };
  }
};
