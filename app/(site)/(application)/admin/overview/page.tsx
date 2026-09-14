export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminHealthScorePanel } from "@/components/admin/AdminHealthScorePanel";
import { AdminOverviewSummary, type AttentionItem } from "@/components/admin/AdminOverviewSummary";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminQuickAccessPanel } from "@/components/admin/AdminQuickAccessPanel";
import { getAdminRole } from "@/lib/adminAuth";
import {
  ADMIN_READ_LIMITS,
  loadAuditRows,
  loadProviderHealthDashboard,
} from "@/lib/adminConsoleData";
import {
  adminEnvironmentChecks,
  blockingEnvChecks,
  processStartedAt,
} from "@/lib/adminEnvironmentChecks";
import { adminHealthBreakdown } from "@/lib/adminHealthScore";
import {
  ADMIN_OVERVIEW_READS,
  adminOverviewFigures,
  type AdminOverviewRead,
} from "@/lib/adminOverviewFigures";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminOverviewMessages } from "@/lib/adminMessages/overview";
import { getAdminActivePaidWhere, getAdminUserStats } from "@/lib/adminUsers";
import { authOptions } from "@/lib/auth";
import { getBillingPlans } from "@/lib/billingConfig";
import { prisma } from "@/lib/prisma";

const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

const TABS = adminNavItemTabs("overview");

/** `2026-09-14T02:31:00.000Z` -> `2026-09-14 02:31`, as the rest of the page does. */
const minuteLabel = (value: Date) => value.toISOString().replace("T", " ").slice(0, 16);

const settled = <T,>(result: PromiseSettledResult<T>): T | null =>
  result.status === "fulfilled" ? result.value : null;

/**
 * The health tab loads the score's own inputs and nothing else.
 *
 * `allSettled` rather than `all`, and the nulls are load-bearing. This page
 * exists to explain a number, so a read that failed has to reach the renderer
 * as "unknown" -- folding it into zero would produce a confident line item for
 * a count nobody obtained, on the one screen whose whole purpose is showing
 * where the number came from.
 */
async function healthTabProps() {
  const [dashboard, alertFailures, pendingRefunds, openFeedback] =
    await Promise.allSettled([
      loadProviderHealthDashboard(),
      prisma.adminNotificationLog.count({
        where: { status: "failed", acknowledgedAt: null },
      }),
      prisma.refundRequest.count({ where: { status: "pending" } }),
      prisma.feedback.count({ where: { status: "open" } }),
    ]);

  const providers = settled(dashboard)?.providers ?? null;
  const envChecks = adminEnvironmentChecks();

  return {
    envChecks,
    breakdown: adminHealthBreakdown({
      outageCount:
        providers?.filter((provider) => provider.status === "outage").length ??
        null,
      limitedCount:
        providers?.filter((provider) => provider.status === "limited").length ??
        null,
      blockingEnvCount: blockingEnvChecks(envChecks).length,
      alertFailureCount: settled(alertFailures),
      pendingRefundCount: settled(pendingRefunds),
      openFeedbackCount: settled(openFeedback),
    }),
    processStartedAt: minuteLabel(processStartedAt()),
  };
}

/**
 * Overview loads what Overview shows, and nothing else.
 *
 * The previous single workspace ran the union of every page's queries before it
 * decided which page it was rendering: the refund table, the credit ledger, the
 * feedback inbox, the provider incident history, the model registry and the
 * analytics rollup were all fetched to draw a KPI strip. This page's reads are
 * the ones its own sections display.
 */
export default async function AdminOverviewPage({
  searchParams,
}: PageProps<"/admin/overview">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const tabStrip = (
    <AdminPageTabs
      basePath="/admin/overview"
      tabs={TABS}
      activeTabId={tab.id}
      label="Overview sections"
      query={query}
    />
  );

  if (tab.id === "health") {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabStrip}
        <AdminHealthScorePanel {...(await healthTabProps())} />
      </div>
    );
  }

  const m = await getAdminMessages(adminOverviewMessages);
  const now = new Date();
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );

  // Read separately, and not through `allSettled`: with the JWT session
  // strategy this decodes a cookie rather than querying anything, the layout
  // above has already required it, and a role that silently fell back to
  // "readonly" would misreport who is signed in.
  const adminRole = getAdminRole(await getServerSession(authOptions)) || "readonly";

  /**
   * Thirteen independent reads, and one of them failing is not thirteen of them
   * failing.
   *
   * These used to sit in a single `Promise.all`, so any rejection took the
   * whole workspace to the error boundary. The read most likely to reject is
   * `loadProviderHealthDashboard()`, and the moment it is most likely to reject
   * is a provider incident -- which is the moment an operator opens Overview to
   * find out about that incident. The console layout has read its own badge
   * counts this way since it was split up (`lib/adminNavigationCounts.ts`); the
   * pages never got the same treatment.
   *
   * Each result reaches `adminOverviewFigures()` as `T | null`, and that module
   * refuses to turn a null into a number.
   */
  const results = await Promise.allSettled([
    loadProviderHealthDashboard(),
    getAdminUserStats(),
    getBillingPlans(),
    prisma.user.groupBy({
      by: ["plan"],
      where: getAdminActivePaidWhere(now),
      _count: { _all: true },
    }),
    prisma.chatUsageBucket.aggregate({
      where: { period: "day", periodStart: dayStart, key: { startsWith: "user:" } },
      _sum: { count: true },
    }),
    prisma.chatUsageBucket.aggregate({
      where: { period: "month", periodStart: monthStart, key: { startsWith: "user:" } },
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

  // Degrading quietly would trade a loud failure for a silent one, so each
  // rejection is reported as itself. `console.warn` with a JSON body is the
  // convention `billing_price_catalog_fallback` set: the request succeeded and
  // what is broken is behind it.
  const unreadable: AdminOverviewRead[] = [];
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const read = ADMIN_OVERVIEW_READS[index];
    unreadable.push(read);
    console.warn(
      JSON.stringify({
        event: "admin_overview_read_failed",
        read,
        reason: result.reason instanceof Error ? result.reason.name : "unknown",
        at: new Date().toISOString(),
      })
    );
  });

  const value = <T,>(index: number): T | null => {
    const result = results[index];
    return result.status === "fulfilled" ? (result.value as T) : null;
  };

  const dashboard = value<Awaited<ReturnType<typeof loadProviderHealthDashboard>>>(0);
  const usageCount = (index: number) => {
    const row = value<{ _sum: { count: number | null } }>(index);
    return row ? (row._sum.count ?? 0) : null;
  };

  const figures = adminOverviewFigures({
    providers: dashboard?.providers ?? null,
    userStats: value<Awaited<ReturnType<typeof getAdminUserStats>>>(1),
    billingPlans: value<Awaited<ReturnType<typeof getBillingPlans>>>(2),
    activePlanGroups: value<Array<{ plan: string | null; _count: { _all: number } }>>(3),
    todayUsageCount: usageCount(4),
    monthlyUsageCount: usageCount(5),
    openFeedbackCount: value<number>(6),
    pendingRefundCount: value<number>(7),
    approvedRefundCount: value<number>(8),
    promotionRedemptions: value<number>(9),
    alertFailureCount: value<number>(10),
  });
  const auditRowsRead = value<Awaited<ReturnType<typeof loadAuditRows>>>(11);
  // An empty activity list and an unread one look the same in this component,
  // which is acceptable only because the banner names the failed read: the
  // list itself is bounded and captioned as "the N most recent", not a total.
  const auditRows = auditRowsRead === null ? [] : auditRowsRead;

  const envChecks = adminEnvironmentChecks();
  // Only the rows whose absence breaks something. Counting every unset
  // variable made an optional Discord webhook cost more than a provider
  // running limited, and drove a correctly-configured deployment to zero.
  const blockingEnvCount = blockingEnvChecks(envChecks).length;
  const health = adminHealthBreakdown({
    outageCount: figures.providers?.outage ?? null,
    limitedCount: figures.providers?.limited ?? null,
    pendingRefundCount: figures.pendingRefundCount,
    openFeedbackCount: figures.openFeedbackCount,
    blockingEnvCount,
    alertFailureCount: figures.alertFailureCount,
  });

  /** A figure that was read, or the label that says it was not. */
  const shown = (
    figure: number | null,
    format: (figure: number) => string = String
  ) => (figure === null ? null : format(figure));
  const percent = (figure: number | null) =>
    figure === null ? null : `${figure.toFixed(1)}%`;
  /** The detail line under a KPI, replaced when its own inputs are missing. */
  const detail = (ready: boolean, text: () => string) =>
    ready ? text() : m.summary.unreadableDetail;

  // Hoisted, so the attention list reads the same whether or not the dashboard
  // came back: no providers to warn about is the honest answer when the read
  // failed, and the banner above the list is what says the read failed.
  const providerRows = dashboard ? dashboard.providers : [];
  const needsAttention: AttentionItem[] = [
    ...providerRows
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
    ...providerRows
      .filter((provider) => !provider.apiKeyConfigured)
      .map((provider) => ({
        title: m.attention.apiKeyMissing(provider.displayName),
        detail: m.attention.apiKeyMissingDetail,
        tone: "zinc" as const,
        href: `/admin/providers/${provider.provider}`,
      })),
    ...(figures.openFeedbackCount && figures.openFeedbackCount > 0
      ? [
          {
            title: m.attention.openFeedback(figures.openFeedbackCount),
            detail: m.attention.openFeedbackDetail,
            tone: "blue" as const,
            href: "/admin/support?tab=feedback",
          },
        ]
      : []),
    ...(figures.pendingRefundCount && figures.pendingRefundCount > 0
      ? [
          {
            title: m.attention.pendingRefunds(figures.pendingRefundCount),
            detail: m.attention.pendingRefundsDetail,
            tone: "amber" as const,
            href: "/admin/refunds",
          },
        ]
      : []),
  ].slice(0, 6);

  const generatedAtLabel = (
    dashboard ? dashboard.generatedAt : now.toISOString()
  )
    .replace("T", " ")
    .slice(0, 16);

  // The snapshot is pasted into incident notes and tickets, so a figure that
  // was never read has to say so there too. A zero in a pasted report outlives
  // the screen it came from.
  const reported = (figure: number | null, format: (n: number) => string = String) =>
    figure === null ? m.report.unreadable : format(figure);
  const snapshotReport = [
    m.report.title,
    m.report.generated(generatedAtLabel),
    figures.totalUsers === null || figures.paidUsers === null
      ? m.report.usersUnreadable
      : m.report.users(
          figures.totalUsers,
          figures.paidUsers,
          figures.activeSubscriptions === null
            ? figures.paidUsers
            : figures.activeSubscriptions
        ),
    figures.providers
      ? m.report.providers(figures.providers.available, figures.providers.total)
      : m.report.providersUnreadable,
    m.report.monthlySpend(reported(figures.monthSpendMicroUsd, money)),
    m.report.openFeedback(reported(figures.openFeedbackCount)),
    m.report.pendingRefunds(reported(figures.pendingRefundCount)),
    m.report.missingEnv(
      blockingEnvChecks(envChecks)
        .map((check) => check.name)
        .join(", ") || m.report.none
    ),
    m.report.needsAttention,
    needsAttention.map((item) => `- ${item.title}: ${item.detail}`).join("\n") ||
      m.report.noAttentionItems,
  ].join("\n");

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabStrip}
      <AdminQuickAccessPanel />
      <AdminOverviewSummary
        blockingEnvCount={blockingEnvCount}
        processStartedAt={minuteLabel(processStartedAt())}
        generatedAt={generatedAtLabel}
        adminRole={adminRole}
        healthScore={health.score}
        healthScoreIncomplete={health.incomplete}
        unreadableReads={unreadable.map((read) => m.summary.readName[read])}
        snapshotReport={snapshotReport}
        operationalKpis={[
          {
            label: m.kpi.users,
            value: shown(figures.totalUsers),
            detail: detail(
              figures.paidUsers !== null && figures.activeSubscriptions !== null,
              () =>
                m.kpi.usersDetail(
                  figures.paidUsers as number,
                  figures.activeSubscriptions as number
                )
            ),
          },
          {
            label: m.kpi.workQueue,
            value: shown(figures.workQueueTotal),
            detail: detail(
              figures.openFeedbackCount !== null &&
                figures.pendingRefundCount !== null,
              () =>
                m.kpi.workQueueDetail(
                  figures.openFeedbackCount as number,
                  figures.pendingRefundCount as number
                )
            ),
            tone: figures.workQueueTotal && figures.workQueueTotal > 0 ? "amber" : "zinc",
          },
          {
            label: m.kpi.providers,
            value: figures.providers
              ? `${figures.providers.available} / ${figures.providers.total}`
              : null,
            detail: detail(figures.providers !== null, () =>
              m.kpi.providersDetail(
                figures.providers!.limited,
                figures.providers!.outage
              )
            ),
            tone:
              figures.providers && figures.providers.outage > 0 ? "amber" : "zinc",
          },
          {
            label: m.kpi.monthlySpend,
            value: shown(figures.monthSpendMicroUsd, money),
            detail: detail(
              figures.todayUsageCount !== null && figures.monthlyUsageCount !== null,
              () =>
                m.kpi.monthlySpendDetail(
                  figures.todayUsageCount as number,
                  figures.monthlyUsageCount as number
                )
            ),
          },
        ]}
        commercialKpis={[
          {
            label: m.kpi.estimatedMrr,
            value: shown(
              figures.monthlyRevenueCents,
              (cents) => `$${(cents / 100).toFixed(0)}`
            ),
            detail: detail(
              figures.monthlyRevenueCents !== null,
              () => m.kpi.estimatedMrrDetail
            ),
            tone: "emerald",
          },
          {
            label: m.kpi.paidConversion,
            value: percent(figures.paidConversionPercent),
            detail: detail(
              figures.paidUsers !== null && figures.totalUsers !== null,
              () =>
                m.kpi.paidConversionDetail(
                  figures.paidUsers as number,
                  figures.totalUsers as number
                )
            ),
            tone: "blue",
          },
          {
            label: m.kpi.planMix,
            value:
              figures.activeProCount !== null && figures.activeMaxCount !== null
                ? `${figures.activeProCount} / ${figures.activeMaxCount}`
                : null,
            detail: detail(figures.activeProCount !== null, () => m.kpi.planMixDetail),
            tone: "purple",
          },
          {
            label: m.kpi.promoRedemptions,
            value: shown(figures.promotionRedemptions),
            detail: detail(
              figures.promotionRedemptions !== null,
              () => m.kpi.promoRedemptionsDetail
            ),
            tone: "amber",
          },
          {
            label: m.kpi.churnWatch,
            value: shown(figures.cancelAtPeriodEndCount),
            detail: detail(figures.refundRatePercent !== null, () =>
              m.kpi.churnWatchDetail(percent(figures.refundRatePercent) as string)
            ),
            tone:
              figures.cancelAtPeriodEndCount && figures.cancelAtPeriodEndCount > 0
                ? "amber"
                : "zinc",
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
