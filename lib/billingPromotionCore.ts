export type PromotionValidationReason =
  | "invalid"
  | "unavailable"
  | "not_started"
  | "expired"
  | "redemption_limit"
  | "plan_not_eligible"
  | "annual_not_allowed"
  | "already_used";

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
  if (planId && !promotion.appliesToPlanIds.includes(planId)) {
    return "plan_not_eligible";
  }
  if (billingInterval === "annual" && !promotion.allowAnnualStacking) {
    return "annual_not_allowed";
  }
  return null;
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
