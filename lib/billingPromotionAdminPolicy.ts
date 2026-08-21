import { isFixedAmountPromotion } from "@/lib/billingPromotionCore";

/**
 * What the Admin surface may still do to a fixed-amount promotion.
 *
 * `docs/policy/promotion-discount-currency.md` §2 decided that new promotions
 * are percentage-only, and §4 wrote down what that means for the codes that
 * already exist: keep them, let them be narrowed, refuse anything that widens
 * them. "Editing is allowed" on its own would have made the creation block
 * decorative -- create a percentage code, save, then edit it into a fixed
 * amount.
 *
 * The rule is comparative, so it cannot live in the request schema: the Admin
 * panel PATCHes the whole promotion list on every save, so a blanket refusal of
 * every fixed-amount promotion in the body would freeze the entire billing form
 * for as long as one such code exists in the database. What each row is judged
 * against is the row already stored under its id.
 */
export type FixedAmountPromotionRefusalReason =
  | "creation"
  | "converted_to_fixed_amount"
  | "converted_to_percentage"
  | "reactivation"
  | "code_changed"
  | "amount_increase"
  | "plan_added"
  | "end_date_extended"
  | "start_date_advanced"
  | "redemption_cap_raised"
  | "duration_extended";

export type AdminPromotionPolicyInput = {
  code: string;
  discountPercent: number;
  discountAmountCents: number | null;
  maxRedemptions: number | null;
  durationMonths: number;
  appliesToPlanIds: readonly string[];
  /** ISO 8601, as both the Admin payload and a normalized Prisma row carry it. */
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
};

export type FixedAmountPromotionRefusal = {
  code: string;
  reason: FixedAmountPromotionRefusalReason;
  message: string;
};

export const PROMOTION_FIXED_AMOUNT_BLOCKED = "PROMOTION_FIXED_AMOUNT_BLOCKED";

/** The one line every refusal ends with, so the reason is always traceable. */
const POLICY_REFERENCE =
  "See docs/policy/promotion-discount-currency.md section 4.";

const REFUSAL_MESSAGES: Record<FixedAmountPromotionRefusalReason, string> = {
  creation:
    "Fixed-amount promotions cannot be created. discountAmountCents is a USD amount, so the code would be unusable in every other market. Use a percentage discount instead.",
  converted_to_fixed_amount:
    "An existing promotion cannot be turned into a fixed-amount one. That is a new fixed-amount promotion wearing an old code.",
  converted_to_percentage:
    "A fixed-amount promotion cannot be rewritten as a percentage one. The same code string would mean two different discounts depending on when it was redeemed, which past redemption records cannot be reconciled against. Create a new percentage code instead.",
  reactivation:
    "An inactive fixed-amount promotion cannot be reactivated. Create a percentage promotion instead.",
  code_changed:
    "A fixed-amount promotion's code cannot be changed. A new code string is a new distribution surface, which is the creation this policy blocks.",
  amount_increase:
    "A fixed-amount promotion's discount cannot be raised. It can be lowered.",
  plan_added:
    "A fixed-amount promotion cannot be extended to another plan. Plans can be removed.",
  end_date_extended:
    "A fixed-amount promotion's end date cannot be pushed back or removed. It can be brought forward.",
  start_date_advanced:
    "A fixed-amount promotion's start date cannot be moved earlier, which would widen the window it is live for.",
  redemption_cap_raised:
    "A fixed-amount promotion's redemption cap cannot be raised or removed. It can be lowered.",
  duration_extended:
    "A fixed-amount promotion's duration in months cannot be extended. It can be shortened.",
};

export const fixedAmountRefusalMessage = (
  reason: FixedAmountPromotionRefusalReason
) => `${REFUSAL_MESSAGES[reason]} ${POLICY_REFERENCE}`;

const timestamp = (value: string | null) => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const refusal = (
  code: string,
  reason: FixedAmountPromotionRefusalReason
): FixedAmountPromotionRefusal => ({
  code,
  reason,
  message: fixedAmountRefusalMessage(reason),
});

/**
 * The first reason this promotion write is refused, or null if it is allowed.
 *
 * `existing` is the stored row under the same id, or null when the write would
 * create one. Percentage promotions -- and internal passes, which the request
 * schema already pins to 100% -- are none of this function's business and
 * return null immediately, whatever else the write changes about them.
 *
 * The first refusal is returned rather than all of them: an admin who added a
 * plan *and* pushed the end date back needs to know the edit is refused and
 * why, and listing every clause of a change that will not be saved is noise.
 */
export const fixedAmountPromotionRefusal = ({
  existing,
  next,
}: {
  existing: AdminPromotionPolicyInput | null;
  next: AdminPromotionPolicyInput;
}): FixedAmountPromotionRefusal | null => {
  const nextIsFixed = isFixedAmountPromotion(next);
  const existingIsFixed = existing ? isFixedAmountPromotion(existing) : false;

  if (!existing) {
    return nextIsFixed ? refusal(next.code, "creation") : null;
  }
  if (!existingIsFixed) {
    // A percentage promotion staying a percentage promotion is unconstrained.
    return nextIsFixed ? refusal(next.code, "converted_to_fixed_amount") : null;
  }
  if (!nextIsFixed) {
    return refusal(next.code, "converted_to_percentage");
  }

  if (!existing.isActive && next.isActive) {
    return refusal(next.code, "reactivation");
  }
  if (existing.code !== next.code) {
    return refusal(next.code, "code_changed");
  }
  if ((next.discountAmountCents || 0) > (existing.discountAmountCents || 0)) {
    return refusal(next.code, "amount_increase");
  }
  const existingPlans = new Set(existing.appliesToPlanIds);
  if (next.appliesToPlanIds.some((planId) => !existingPlans.has(planId))) {
    return refusal(next.code, "plan_added");
  }

  const existingEndsAt = timestamp(existing.endsAt);
  const nextEndsAt = timestamp(next.endsAt);
  // A stored end date that goes away is the widest edit of all: the promotion
  // stops expiring. A promotion that never had one cannot be widened by
  // gaining one.
  if (existingEndsAt !== null && (nextEndsAt === null || nextEndsAt > existingEndsAt)) {
    return refusal(next.code, "end_date_extended");
  }

  const existingStartsAt = timestamp(existing.startsAt);
  const nextStartsAt = timestamp(next.startsAt);
  // Symmetrically: dropping a future start date makes a scheduled promotion
  // live now, which is the same widening from the other end.
  if (
    existingStartsAt !== null &&
    (nextStartsAt === null || nextStartsAt < existingStartsAt)
  ) {
    return refusal(next.code, "start_date_advanced");
  }

  if (
    existing.maxRedemptions !== null &&
    (next.maxRedemptions === null || next.maxRedemptions > existing.maxRedemptions)
  ) {
    return refusal(next.code, "redemption_cap_raised");
  }
  if (next.durationMonths > existing.durationMonths) {
    return refusal(next.code, "duration_extended");
  }
  return null;
};

/** Every refused promotion in one Admin save, in the order they were sent. */
export const fixedAmountPromotionRefusals = (
  writes: {
    existing: AdminPromotionPolicyInput | null;
    next: AdminPromotionPolicyInput;
  }[]
): FixedAmountPromotionRefusal[] =>
  writes
    .map((write) => fixedAmountPromotionRefusal(write))
    .filter((item): item is FixedAmountPromotionRefusal => item !== null);
