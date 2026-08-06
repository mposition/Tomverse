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
import { getAdminActivePaidWhere, getAdminUserStats } from "@/lib/adminUsers";
import { authOptions } from "@/lib/auth";
import { getBillingPlans } from "@/lib/billingConfig";
import { prisma } from "@/lib/prisma";
import type { ProviderHealthStatus } from "@/lib/providerMonitoring";

const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

const statusCopy: Record<ProviderHealthStatus, string> = {
  available: "Available",
  limited: "Limited",
  outage: "Outage",
};

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
        title: `${provider.displayName} is ${statusCopy[provider.status]}`,
        detail: provider.recentErrorCode || provider.fallback.reason,
        tone: (provider.status === "outage" ? "red" : "amber") as AttentionItem["tone"],
        href: `/admin/providers/${provider.provider}`,
      })),
    ...dashboard.providers
      .filter((provider) => !provider.apiKeyConfigured)
      .map((provider) => ({
        title: `${provider.displayName} API key missing`,
        detail:
          "Provider calls will fail or remain unavailable until the key is configured.",
        tone: "zinc" as const,
        href: `/admin/providers/${provider.provider}`,
      })),
    ...(openFeedbackCount > 0
      ? [
          {
            title: `${openFeedbackCount} open feedback item${
              openFeedbackCount === 1 ? "" : "s"
            }`,
            detail: "Review user-reported issues before launch traffic grows.",
            tone: "blue" as const,
            href: "/admin/support?tab=feedback",
          },
        ]
      : []),
    ...(pendingRefundCount > 0
      ? [
          {
            title: `${pendingRefundCount} pending refund request${
              pendingRefundCount === 1 ? "" : "s"
            }`,
            detail:
              "Review billing cancellation requests and approve or reject them before renewal disputes grow.",
            tone: "amber" as const,
            href: "/admin/refunds",
          },
        ]
      : []),
  ].slice(0, 6);

  const generatedAtLabel = dashboard.generatedAt.replace("T", " ").slice(0, 16);
  const snapshotReport = [
    "Tomverse Admin Snapshot",
    `Generated: ${generatedAtLabel} UTC`,
    `Users: ${totalUsers} total / ${paidUsers} paid / ${activeSubscriptions} active subscriptions`,
    `Providers: ${availableCount}/${dashboard.providers.length} available`,
    `Estimated monthly spend: ${monthSpendLabel}`,
    `Open feedback: ${openFeedbackCount}`,
    `Pending refunds: ${pendingRefundCount}`,
    `Missing environment setup: ${
      envChecks
        .filter((check) => !check.configured)
        .map((check) => check.name)
        .join(", ") || "none"
    }`,
    "Needs attention:",
    needsAttention.map((item) => `- ${item.title}: ${item.detail}`).join("\n") ||
      "- none",
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
            label: "Users",
            value: String(totalUsers),
            detail: `${paidUsers} paid · ${activeSubscriptions} active subscriptions`,
          },
          {
            label: "Work queue",
            value: String(openFeedbackCount + pendingRefundCount),
            detail: `${openFeedbackCount} feedback / ${pendingRefundCount} refunds`,
            tone: openFeedbackCount + pendingRefundCount > 0 ? "amber" : "zinc",
          },
          {
            label: "Providers",
            value: `${availableCount} / ${dashboard.providers.length}`,
            detail: `${limitedCount} limited · ${outageCount} outage`,
            tone: outageCount > 0 ? "amber" : "zinc",
          },
          {
            label: "Monthly spend",
            value: monthSpendLabel,
            detail: `Estimated from reserved token budgets. ${
              todayUsage._sum.count || 0
            } plan credits today, ${monthlyUsage._sum.count || 0} this month (UTC).`,
          },
        ]}
        commercialKpis={[
          {
            label: "Estimated MRR",
            value: `$${(monthlyRevenueCents / 100).toFixed(0)}`,
            detail: "Calculated from active Pro and Max monthly list prices.",
            tone: "emerald",
          },
          {
            label: "Paid conversion",
            value: paidConversion,
            detail: `${paidUsers} active paid users out of ${totalUsers} total accounts.`,
            tone: "blue",
          },
          {
            label: "Plan mix",
            value: `${activeProCount} / ${activeMaxCount}`,
            detail: "Active Pro / Max subscriptions.",
            tone: "purple",
          },
          {
            label: "Promo redemptions",
            value: String(promotionRedemptions),
            detail: "Total redeemed promotion records in the database.",
            tone: "amber",
          },
          {
            label: "Churn watch",
            value: String(cancelAtPeriodEndCount),
            detail: `Cancel at period end. Approved refund rate ${refundRate}.`,
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
