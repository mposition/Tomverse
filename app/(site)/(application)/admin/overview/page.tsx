export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminHealthScorePanel } from "@/components/admin/AdminHealthScorePanel";
import { AdminOverviewSummary } from "@/components/admin/AdminOverviewSummary";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminQuickAccessPanel } from "@/components/admin/AdminQuickAccessPanel";
import { getAdminRole } from "@/lib/adminAuth";
import { buildDecisionInbox } from "@/lib/adminDecisionInbox";
import { loadAdminDecisionInbox } from "@/lib/adminDecisionInboxLoad";
import { adminHomeTeams } from "@/lib/adminHomeAgents";
import { adminHomeMessages } from "@/lib/adminMessages/home";
import { readAgentOfficeLiveRooms } from "@/lib/agentOfficeLiveRead";
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
import { FEEDBACK_AWAITING_OPERATOR_STATUSES } from "@/lib/feedbackLifecycleCore";
import { prisma } from "@/lib/prisma";
import { formatAestDateTime } from "@/lib/adminUiCore";

const money = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

const TABS = adminNavItemTabs("overview");

/** `2026-09-14T02:31:00.000Z` -> `2026-09-14 12:31 AEST`, as the rest of the page does. */
const minuteLabel = (value: Date) => formatAestDateTime(value) || "-";

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
      // The same count the overview's score uses, or this page would explain
      // a different number from the one it is explaining.
      prisma.feedback.count({
        where: { status: { in: [...FEEDBACK_AWAITING_OPERATOR_STATUSES] } },
      }),
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
  const session = await getServerSession(authOptions);
  const adminRole = getAdminRole(session) || "readonly";
  const userName = session?.user?.name?.trim().split(/\s+/)[0] || null;
  const home = await getAdminMessages(adminHomeMessages);

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
  const [results, inboxResult, roomsResult] = await Promise.all([
    Promise.allSettled([
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
    prisma.feedback.count({
      where: { status: { in: [...FEEDBACK_AWAITING_OPERATOR_STATUSES] } },
    }),
    prisma.refundRequest.count({ where: { status: "pending" } }),
    prisma.refundRequest.count({ where: { status: "approved" } }),
    prisma.billingPromotionRedemption.count(),
    prisma.adminNotificationLog.count({
      where: { status: "failed", acknowledgedAt: null },
    }),
    loadAuditRows(ADMIN_READ_LIMITS.recentActivity),
    ]),
    // The decision inbox and the team strip are read beside the figures, each
    // on its own: neither failing changes a number above.
    Promise.allSettled([loadAdminDecisionInbox(adminRole, now)]),
    Promise.allSettled([readAgentOfficeLiveRooms(now)]),
  ]);
  const inbox =
    inboxResult[0].status === "fulfilled"
      ? inboxResult[0].value
      : buildDecisionInbox({ queue: null, counts: null, role: adminRole, now });
  const teams = roomsResult[0].status === "fulfilled" ? adminHomeTeams(roomsResult[0].value) : null;

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

  // The snapshot text keeps an attention list for incident notes: providers
  // that are not available, and the two counts an operator is asked about.
  const providerRows = dashboard ? dashboard.providers : [];
  const needsAttention: Array<{ title: string; detail: string }> = [
    ...providerRows
      .filter((provider) => provider.status !== "available")
      .map((provider) => ({
        title: m.attention.providerStatus(provider.displayName, m.providerStatus[provider.status]),
        detail: provider.recentErrorCode || provider.fallback.reason,
      })),
    ...providerRows
      .filter((provider) => !provider.apiKeyConfigured)
      .map((provider) => ({
        title: m.attention.apiKeyMissing(provider.displayName),
        detail: m.attention.apiKeyMissingDetail,
      })),
    ...(figures.openFeedbackCount && figures.openFeedbackCount > 0
      ? [{ title: m.attention.openFeedback(figures.openFeedbackCount), detail: m.attention.openFeedbackDetail }]
      : []),
    ...(figures.pendingRefundCount && figures.pendingRefundCount > 0
      ? [{ title: m.attention.pendingRefunds(figures.pendingRefundCount), detail: m.attention.pendingRefundsDetail }]
      : []),
  ].slice(0, 6);

  const generatedAtLabel =
    formatAestDateTime(dashboard ? dashboard.generatedAt : now) || "-";

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

  const k = home.today.kpi;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabStrip}
      <AdminOverviewSummary
        now={now}
        userName={userName}
        unreadableReads={unreadable.map((read) => m.summary.readName[read])}
        snapshotReport={snapshotReport}
        kpis={[
          {
            label: k.users,
            value: shown(figures.totalUsers),
            detail: detail(
              figures.paidUsers !== null && figures.activeSubscriptions !== null,
              () => k.usersDetail(figures.paidUsers as number, figures.activeSubscriptions as number)
            ),
          },
          {
            label: k.mrr,
            value: shown(figures.monthlyRevenueCents, (cents) => `$${(cents / 100).toFixed(0)}`),
            detail: detail(figures.monthlyRevenueCents !== null, () => k.mrrDetail),
          },
          {
            label: k.spend,
            value: shown(figures.monthSpendMicroUsd, money),
            detail: detail(
              figures.todayUsageCount !== null && figures.monthlyUsageCount !== null,
              () => k.spendDetail(figures.todayUsageCount as number, figures.monthlyUsageCount as number)
            ),
          },
          {
            label: k.conversion,
            value: percent(figures.paidConversionPercent),
            detail: detail(
              figures.paidUsers !== null && figures.totalUsers !== null,
              () => k.conversionDetail(figures.paidUsers as number, figures.totalUsers as number)
            ),
          },
        ]}
        inbox={inbox}
        teams={teams}
        services={
          dashboard
            ? {
                providers: dashboard.providers.map((provider) => ({
                  provider: provider.provider,
                  displayName: provider.displayName,
                  todayCostMicroUsd: provider.todayCostMicroUsd,
                  status: provider.status,
                })),
                dayBudgetMicroUsd: dashboard.providers.reduce(
                  (sum, provider) => sum + Math.max(0, provider.dayBudgetMicroUsd),
                  0
                ),
              }
            : null
        }
        alertFailureCount={figures.alertFailureCount}
        blockingEnvCount={blockingEnvCount}
        healthScore={health.score}
        healthScoreIncomplete={health.incomplete}
        recentActivity={auditRows}
        recentActivityLimit={ADMIN_READ_LIMITS.recentActivity}
      />
      <AdminQuickAccessPanel />
    </div>
  );
}
