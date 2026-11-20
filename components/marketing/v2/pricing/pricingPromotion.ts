import type { FeaturedBillingPromotion } from "@/components/marketing/usePublicBilling";

/**
 * Wording facts the pricing page derives from the billing data instead of writing them into the
 * copy: a plan's annual saving, which plans a featured promotion applies to, and for how long.
 */
export type PlanPriceFacts = {
  monthlyPriceCents: number;
  annualPriceCents: number;
  displayMonthlyPriceAmount?: number;
  displayAnnualPriceAmount?: number;
};

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * How much cheaper a year is than twelve months, as a whole percent, for this plan in the
 * currency it is shown in. `null` when either price is unknown or the year is not cheaper, so
 * the page shows no saving it cannot back.
 */
export function annualDiscountPercent(plan: PlanPriceFacts | null | undefined): number | null {
  if (!plan) return null;
  // The display amounts are the market price the visitor sees; without both of them the base
  // prices (one currency, both cycles) are the same comparison.
  const [monthly, annual] = positive(plan.displayMonthlyPriceAmount) && positive(plan.displayAnnualPriceAmount)
    ? [plan.displayMonthlyPriceAmount, plan.displayAnnualPriceAmount]
    : [plan.monthlyPriceCents, plan.annualPriceCents];
  if (!positive(monthly) || !positive(annual)) return null;
  const percent = Math.round((1 - annual / (monthly * 12)) * 100);
  return percent > 0 ? percent : null;
}

/** The one saving to name beside a cycle selector: only when every paid plan has the same. */
export function commonDiscountPercent(percents: ReadonlyArray<number | null>): number | null {
  if (percents.length === 0 || percents.some((percent) => percent === null)) return null;
  return percents.every((percent) => percent === percents[0]) ? percents[0] : null;
}

const PLAN_ORDER = ["free", "pro", "max"] as const;
const PLAN_NAMES: Record<(typeof PLAN_ORDER)[number], string> = { free: "Free", pro: "Pro", max: "Max" };

type PromotionTargets = Pick<FeaturedBillingPromotion, "appliesToPlanIds" | "billingIntervals">;

/** Whether the promotion's monthly discount is shown on this plan's card. */
export const promotionAppliesToPlan = (promotion: PromotionTargets | null | undefined, planId: (typeof PLAN_ORDER)[number]) =>
  Boolean(promotion && promotion.appliesToPlanIds.includes(planId) && promotion.billingIntervals.includes("monthly"));

/** Names of the paid plans the promotion applies to, in plan order. */
export const promotionPlanNames = (promotion: Pick<FeaturedBillingPromotion, "appliesToPlanIds"> | null | undefined) =>
  PLAN_ORDER.filter((id) => id !== "free" && promotion?.appliesToPlanIds.includes(id)).map((id) => PLAN_NAMES[id]);

/** "Pro or Max": names joined with the language's word for "or". */
export const joinPlanNames = (names: readonly string[], or: string) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${or} ${names[names.length - 1]}`;

/** "the first month" for one month, "the first 3 months" for more. */
export const promotionPeriodPhrase = (period: { first: string; months: string }, durationMonths: number, formatNumber: (value: number) => string = String) =>
  durationMonths > 1 ? period.months.replace("{n}", formatNumber(durationMonths)) : period.first;
