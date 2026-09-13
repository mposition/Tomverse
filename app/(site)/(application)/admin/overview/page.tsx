export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminOverviewSummary, type AttentionItem } from "@/components/admin/AdminOverviewSummary";
import { AdminQuickAccessPanel } from "@/components/admin/AdminQuickAccessPanel";
import { getAdminRole } from "@/lib/adminAuth";
import {
  ADMIN_READ_LIMITS,
  loadAuditRows,
  loadProviderHealthDashboard,
} from "@/lib/adminConsoleData";
import {
  adminEnvironmentChecks,
  adminHealthScore,
} from "@/lib/adminEnvironmentChecks";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminOverviewMessages } from "@/lib/adminMessages/overview";
import { getAdminActivePaidWhere, getAdminUserStats } from "@/lib/adminUsers";
import { authOptions } from "@/lib/auth";
import { getBillingPlans } from "@/lib/billingConfig";
import { prisma } from "@/lib/prisma";

const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

/**
 * Overview loads what Overview shows, and nothing else.
 *
 * The previous single workspace ran the union of every page's queries before it
 * decided which page it was rendering: the refund table, the credit ledger, the
 * feedback inbox, the provider incident history, the model registry and the
 * analytics rollup were all fetched to draw a KPI strip. This page's reads are
 * the ones its own sections display.
 */
export default async function AdminOverviewPage() {
  const m = await getAdminMessages(adminOverviewMessages);
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );

  const [
    session,
    dashboard,
    userStats,
    billingPlans,
    activePlanGroups,
    todayUsage,
    monthlyUsage,
    openFeedbackCount,
    pendingRefundCount,
    approvedRefundCount,
    promotionRedemptions,
    alertFailureCount,
    auditRows,
  ] = await Promise.all([
    getServerSession(authOptions),
    loadProviderHealthDashboard(),
    getAdminUserStats(),
    getBillingPlans(),
    prisma.user.groupBy({
      by: ["plan"],
      where: getAdminActivePaidWhere(now),
      _count: { _all: true },
    }),
    prisma.chatUsageBucket.aggregate({
      where: {
        period: "day",
        periodStart: dayStart,
        key: { startsWith: "user:" },
      },
      _sum: { count: true },
    }),
    prisma.chatUsageBucket.aggregate({
      where: {
        period: "month",
        periodStart: monthStart,
        key: { startsWith: "user:" },
      },
      _sum: { count: true },
    }),
    prisma.feedback.count({ where: { status: "open" } }),
    prisma.refundRequest.count({ where: { status: "pending" } }),
    prisma.refundRequest.count({ where: { status: "approved" } }),
    prisma.billingPromotionRedemption.count(),
    prisma.adminNotificationLog.count({
      where: { status: "failed", acknowledgedAt: null },
    }),
    loadAuditRows(ADMIN_READ_LIMITS.recentActivity),
  ]);

  const adminRole = getAdminRole(session) || "readonly";
  const availableCount = dashboard.providers.filter(
    (provider) => provider.status === "available"
  ).length;
  const limitedCount = dashboard.providers.filter(
    (provider) => provider.status === "limited"
  ).length;
  const outageCount = dashboard.providers.filter(
    (provider) => provider.status === "outage"
  ).length;
  const monthSpend = dashboard.providers.reduce(
    (sum, provider) => sum + provider.monthCostMicroUsd,
    0
  );
  const monthSpendLabel = money(monthSpend);

  const totalUsers = userStats.totalAccounts;
  const paidUsers = userStats.activePaidSubscriptions;
  const activeSubscriptions = userStats.activePaidSubscriptions;
  const cancelAtPeriodEndCount = userStats.cancelingSubscriptions;

  const activePlanCounts = new Map(
    activePlanGroups.map((group) => [group.plan || "Free", group._count._all])
  );
  const activeProCount = activePlanCounts.get("Pro") || 0;
  const activeMaxCount = activePlanCounts.get("Max") || 0;
  const billingPlanById = new Map(billingPlans.map((plan) => [plan.id, plan]));
  const monthlyRevenueCents =
    activeProCount * (billingPlanById.get("pro")?.monthlyPriceCents || 0) +
    activeMaxCount * (billingPlanById.get("max")?.monthlyPriceCents || 0);
  const paidConversion =
    totalUsers > 0 ? `${((paidUsers / totalUsers) * 100).toFixed(1)}%` : "0.0%";
  const refundRate = `${(
    (approvedRefundCount / Math.max(paidUsers + approvedRefundCount, 1)) *
    100
  ).toFixed(1)}%`;

  const envChecks = adminEnvironmentChecks();
  const missingEnvCount = envChecks.filter((check) => !check.configured).length;
  const healthScore = adminHealthScore({
    outageCount,
    limitedCount,
    pendingRefundCount,
    openFeedbackCount,
    missingEnvCount,
    alertFailureCount,
  });

  const needsAttention: AttentionItem[] = [
    ...dashboard.providers
      .filter((provider) => provider.status !== "available")
      .map((provider) => ({
        title: m.attention.providerStatus(
          provider.displayName,
          m.providerStatus[provider.status]
        ),
        detail: provider.recentErrorCode || provider.fallback.reason,
        tone: (provider.status === "outage" ? "red" : "amber") as AttentionItem["tone"],
        href: `/admin/providers/${provider.provider}`,
      })),
    ...dashboard.providers
      .filter((provider) => !provider.apiKeyConfigured)
      .map((provider) => ({
        title: m.attention.apiKeyMissing(provider.displayName),
        detail: m.attention.apiKeyMissingDetail,
        tone: "zinc" as const,
        href: `/admin/providers/${provider.provider}`,
      })),
    ...(openFeedbackCount > 0
      ? [
          {
            title: m.attention.openFeedback(openFeedbackCount),
            detail: m.attention.openFeedbackDetail,
            tone: "blue" as const,
            href: "/admin/support?tab=feedback",
          },
        ]
      : []),
    ...(pendingRefundCount > 0
      ? [
          {
            title: m.attention.pendingRefunds(pendingRefundCount),
            detail: m.attention.pendingRefundsDetail,
            tone: "amber" as const,
            href: "/admin/refunds",
          },
        ]
      : []),
  ].slice(0, 6);

  const generatedAtLabel = dashboard.generatedAt.replace("T", " ").slice(0, 16);
  const snapshotReport = [
    m.report.title,
    m.report.generated(generatedAtLabel),
    m.report.users(totalUsers, paidUsers, activeSubscriptions),
    m.report.providers(availableCount, dashboard.providers.length),
    m.report.monthlySpend(monthSpendLabel),
    m.report.openFeedback(openFeedbackCount),
    m.report.pendingRefunds(pendingRefundCount),
    m.report.missingEnv(
      envChecks
        .filter((check) => !check.configured)
        .map((check) => check.name)
        .join(", ") || m.report.none
    ),
    m.report.needsAttention,
    needsAttention.map((item) => `- ${item.title}: ${item.detail}`).join("\n") ||
      m.report.noAttentionItems,
  ].join("\n");

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminQuickAccessPanel />
      <AdminOverviewSummary
        generatedAt={generatedAtLabel}
        adminRole={adminRole}
        healthScore={healthScore}
        snapshotReport={snapshotReport}
        operationalKpis={[
          {
            label: m.kpi.users,
            value: String(totalUsers),
            detail: m.kpi.usersDetail(paidUsers, activeSubscriptions),
          },
          {
            label: m.kpi.workQueue,
            value: String(openFeedbackCount + pendingRefundCount),
            detail: m.kpi.workQueueDetail(openFeedbackCount, pendingRefundCount),
            tone: openFeedbackCount + pendingRefundCount > 0 ? "amber" : "zinc",
          },
          {
            label: m.kpi.providers,
            value: `${availableCount} / ${dashboard.providers.length}`,
            detail: m.kpi.providersDetail(limitedCount, outageCount),
            tone: outageCount > 0 ? "amber" : "zinc",
          },
          {
            label: m.kpi.monthlySpend,
            value: monthSpendLabel,
            detail: m.kpi.monthlySpendDetail(
              todayUsage._sum.count || 0,
              monthlyUsage._sum.count || 0
            ),
          },
        ]}
        commercialKpis={[
          {
            label: m.kpi.estimatedMrr,
            value: `$${(monthlyRevenueCents / 100).toFixed(0)}`,
            detail: m.kpi.estimatedMrrDetail,
            tone: "emerald",
          },
          {
            label: m.kpi.paidConversion,
            value: paidConversion,
            detail: m.kpi.paidConversionDetail(paidUsers, totalUsers),
            tone: "blue",
          },
          {
            label: m.kpi.planMix,
            value: `${activeProCount} / ${activeMaxCount}`,
            detail: m.kpi.planMixDetail,
            tone: "purple",
          },
          {
            label: m.kpi.promoRedemptions,
            value: String(promotionRedemptions),
            detail: m.kpi.promoRedemptionsDetail,
            tone: "amber",
          },
          {
            label: m.kpi.churnWatch,
            value: String(cancelAtPeriodEndCount),
            detail: m.kpi.churnWatchDetail(refundRate),
            tone: cancelAtPeriodEndCount > 0 ? "amber" : "zinc",
          },
        ]}
        needsAttention={needsAttention}
        envChecks={envChecks}
        recentActivity={auditRows}
        recentActivityLimit={ADMIN_READ_LIMITS.recentActivity}
      />
    </div>
  );
}
