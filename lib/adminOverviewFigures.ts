/**
 * Overview's figures, derived from reads that are allowed to have failed.
 *
 * ## Why this is a module and not thirty lines in the page
 *
 * Overview ran thirteen independent reads inside one `Promise.all`, so a single
 * rejection took the whole workspace to the error boundary -- including the
 * provider health dashboard, which is the read most likely to fail during a
 * provider incident and the one an operator opens Overview to look at. The page
 * now uses `allSettled`, and that turns every input into `T | null`.
 *
 * Which is where the interesting bug lives. `null` coerces to zero the moment
 * anyone writes `?? 0` or `|| 0` to keep TypeScript quiet, and a zero here is
 * not a shrug -- it is a claim. "Paid conversion 0.0%", "$0 MRR" and "0 open
 * feedback" are all statements an operator would act on, assembled out of a
 * read that never came back. The same rule `lib/adminNavigationCounts.ts`
 * states for badges: zero is a claim and an unknown count is not.
 *
 * So every derivation lives here, every one propagates null, and
 * `tests/adminOverviewFigures.test.mjs` asserts that no combination of missing
 * inputs produces a confident number. A rendering component cannot make that
 * mistake if it is never handed a number that was invented.
 *
 * Percentages come back as numbers rather than formatted strings: formatting is
 * the caller's, and a function that returned "0.0%" for an unknown input would
 * be the very defect this exists to prevent.
 */

export type ProviderStatus = "available" | "limited" | "outage";

export type OverviewProviderRow = {
  status: ProviderStatus | string;
  monthCostMicroUsd: number;
};

export type OverviewUserStats = {
  totalAccounts: number;
  activePaidSubscriptions: number;
  cancelingSubscriptions: number;
};

export type OverviewBillingPlan = { id: string; monthlyPriceCents: number };

export type OverviewPlanGroup = {
  plan: string | null;
  _count: { _all: number };
};

export type AdminOverviewReads = {
  providers: OverviewProviderRow[] | null;
  userStats: OverviewUserStats | null;
  billingPlans: OverviewBillingPlan[] | null;
  activePlanGroups: OverviewPlanGroup[] | null;
  todayUsageCount: number | null;
  monthlyUsageCount: number | null;
  openFeedbackCount: number | null;
  pendingRefundCount: number | null;
  approvedRefundCount: number | null;
  promotionRedemptions: number | null;
  alertFailureCount: number | null;
};

export type AdminOverviewFigures = {
  providers: {
    available: number;
    limited: number;
    outage: number;
    total: number;
  } | null;
  monthSpendMicroUsd: number | null;
  totalUsers: number | null;
  paidUsers: number | null;
  activeSubscriptions: number | null;
  cancelAtPeriodEndCount: number | null;
  activeProCount: number | null;
  activeMaxCount: number | null;
  monthlyRevenueCents: number | null;
  /** 0-100, or null when either side of the ratio is unknown. */
  paidConversionPercent: number | null;
  /** 0-100, or null when either side of the ratio is unknown. */
  refundRatePercent: number | null;
  /** Open feedback plus pending refunds. Null unless *both* were read. */
  workQueueTotal: number | null;
  todayUsageCount: number | null;
  monthlyUsageCount: number | null;
  openFeedbackCount: number | null;
  pendingRefundCount: number | null;
  promotionRedemptions: number | null;
  alertFailureCount: number | null;
};

const countByStatus = (rows: OverviewProviderRow[], status: string) =>
  rows.filter((row) => row.status === status).length;

export const adminOverviewFigures = (
  reads: AdminOverviewReads
): AdminOverviewFigures => {
  const providers = reads.providers
    ? {
        available: countByStatus(reads.providers, "available"),
        limited: countByStatus(reads.providers, "limited"),
        outage: countByStatus(reads.providers, "outage"),
        total: reads.providers.length,
      }
    : null;

  const monthSpendMicroUsd = reads.providers
    ? reads.providers.reduce((sum, row) => sum + row.monthCostMicroUsd, 0)
    : null;

  const totalUsers = reads.userStats?.totalAccounts ?? null;
  const paidUsers = reads.userStats?.activePaidSubscriptions ?? null;

  // The plan mix needs the grouped rows; the revenue estimate needs those *and*
  // the price list. Split so a failed price read costs the mix nothing.
  const planCounts = reads.activePlanGroups
    ? new Map(
        reads.activePlanGroups.map((group) => [
          group.plan || "Free",
          group._count._all,
        ])
      )
    : null;
  const activeProCount = planCounts ? (planCounts.get("Pro") ?? 0) : null;
  const activeMaxCount = planCounts ? (planCounts.get("Max") ?? 0) : null;

  const planPrices = reads.billingPlans
    ? new Map(reads.billingPlans.map((plan) => [plan.id, plan.monthlyPriceCents]))
    : null;
  const monthlyRevenueCents =
    planPrices && activeProCount !== null && activeMaxCount !== null
      ? activeProCount * (planPrices.get("pro") ?? 0) +
        activeMaxCount * (planPrices.get("max") ?? 0)
      : null;

  // A ratio with an unknown denominator is not zero, and a zero denominator is
  // not a ratio. Both answer null rather than 0.0.
  const paidConversionPercent =
    paidUsers !== null && totalUsers !== null && totalUsers > 0
      ? (paidUsers / totalUsers) * 100
      : null;

  const refundRatePercent =
    reads.approvedRefundCount !== null && paidUsers !== null
      ? (reads.approvedRefundCount /
          Math.max(paidUsers + reads.approvedRefundCount, 1)) *
        100
      : null;

  const workQueueTotal =
    reads.openFeedbackCount !== null && reads.pendingRefundCount !== null
      ? reads.openFeedbackCount + reads.pendingRefundCount
      : null;

  return {
    providers,
    monthSpendMicroUsd,
    totalUsers,
    paidUsers,
    activeSubscriptions: paidUsers,
    cancelAtPeriodEndCount: reads.userStats?.cancelingSubscriptions ?? null,
    activeProCount,
    activeMaxCount,
    monthlyRevenueCents,
    paidConversionPercent,
    refundRatePercent,
    workQueueTotal,
    todayUsageCount: reads.todayUsageCount,
    monthlyUsageCount: reads.monthlyUsageCount,
    openFeedbackCount: reads.openFeedbackCount,
    pendingRefundCount: reads.pendingRefundCount,
    promotionRedemptions: reads.promotionRedemptions,
    alertFailureCount: reads.alertFailureCount,
  };
};

/**
 * The reads Overview makes, in the order the page issues them.
 *
 * Named so a failed one can be reported as itself. "Something on this page
 * could not be loaded" tells an operator to distrust the whole screen; naming
 * the read tells them which figure to distrust and which are still good.
 */
export const ADMIN_OVERVIEW_READS = [
  "providerHealth",
  "userStats",
  "billingPlans",
  "activePlanGroups",
  "todayUsage",
  "monthlyUsage",
  "openFeedback",
  "pendingRefunds",
  "approvedRefunds",
  "promotionRedemptions",
  "alertFailures",
  "recentActivity",
] as const;

export type AdminOverviewRead = (typeof ADMIN_OVERVIEW_READS)[number];
