export const dynamic = "force-dynamic";

import Link from "next/link";
import { AdminAiReviewScorecardPanel } from "@/components/admin/AdminAiReviewScorecardPanel";
import { AdminAiReviewJudgedPanel } from "@/components/admin/AdminAiReviewJudgedPanel";
import { readAiReviewJudgedRunCatalog } from "@/lib/aiReviewJudgedRunReport";
import { readAiReviewPreparationCatalog } from "@/lib/aiReviewPreparationServer";
import { AdminAiReviewPreparationPanel } from "@/components/admin/AdminAiReviewPreparationPanel";
import { AdminAiReviewThresholdDraft } from "@/components/admin/AdminAiReviewThresholdDraft";
import { AdminAiReviewM5Progress } from "@/components/admin/AdminAiReviewM5Progress";
import { aiReviewM5Progress } from "@/lib/aiReviewM5Progress";
import { getAdminLocale, getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAiReviewJudgedMessages } from "@/lib/adminMessages/aiReviewJudged";
import { AdminMemoryImportPanel } from "@/components/admin/AdminMemoryImportPanel";
import { AdminMemoryRevocationPanel } from "@/components/admin/AdminMemoryRevocationPanel";
import { AdminPackageImportPanel } from "@/components/admin/AdminPackageImportPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminProductAnalyticsPanel } from "@/components/admin/AdminProductAnalyticsPanel";
import { AdminUsageAnalyticsPanel } from "@/components/admin/AdminUsageAnalyticsPanel";
import { LaunchFunnelPanel } from "@/components/admin/AdminRiskPanels";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { getAssistantPackageImportMetrics } from "@/lib/assistantPackageImportMetrics";
import { getAdminUserStats } from "@/lib/adminUsers";
import { readUsageAnalytics } from "@/lib/adminUsageAnalytics";
import { parseUsagePeriod } from "@/lib/adminUsageAnalyticsCore";
import { prisma } from "@/lib/prisma";
import { getProductAnalyticsDashboard } from "@/lib/productAnalyticsDashboard";
import {
  AI_REVIEW_SCORECARD_WINDOWS,
  readAiReviewScorecard,
} from "@/lib/aiReviewScorecard";

const TABS = adminNavItemTabs("analytics");

/**
 * Usage, product analytics, import/memory and AI Review metrics, as separate tabs.
 *
 * They answer different questions from different sources -- one is the consented
 * event ledger, the other is content-free import and memory telemetry -- and
 * stacking them on one page made a long scroll where the second half looked
 * like a footnote to the first. Splitting them also means opening the funnel
 * does not issue the two report fetches, and vice versa.
 *
 * The account-level launch funnel moved here too: it used to be rendered on the
 * promotions workspace, which is not where anyone looks for a conversion funnel.
 */
export default async function AdminAnalyticsPage({
  searchParams,
}: PageProps<"/admin/analytics">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  const tabs = (
    <AdminPageTabs
      basePath="/admin/analytics"
      tabs={TABS}
      activeTabId={tab.id}
      label="Analytics sections"
      query={query}
    />
  );

  if (tab.id === "usage") {
    // The first tab, because "how many people are actually using this" is the
    // question an operator opens Analytics with. The period is in the URL like
    // the tab, so a report can be linked and reloaded as the same report.
    const report = await readUsageAnalytics(parseUsagePeriod(query.period));
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AdminUsageAnalyticsPanel report={report} />
      </div>
    );
  }

  if (tab.id === "imports") {
    const packageImports = await getAssistantPackageImportMetrics();
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        <AdminMemoryImportPanel />
        {/*
          Read here rather than fetched by the panel: this one is a single
          grouped query over the event ledger, and the tab is already a server
          component. The memory panel above fetches because its two reports are
          separate endpoints that can each be unavailable.
        */}
        <AdminPackageImportPanel metrics={packageImports} />
        {/*
          The §12.1 revocation control sits under the report it reacts to: the
          per-pair failure table above is where an operator sees one pair
          failing, and stopping that pair is the next action. It is the only
          write on this tab, and it only ever restricts.
        */}
        <AdminMemoryRevocationPanel />
      </div>
    );
  }

  if (tab.id === "ai-review") {
    const locale = await getAdminLocale();
    const preparation = query.reviewView !== "reports";
    const reviewNavigation = (
      <nav
        aria-label={locale === "ko" ? "AI Review 작업" : "AI Review workspace"}
        className="flex flex-wrap gap-3 text-sm"
      >
        <Link
          href="/admin/analytics?tab=ai-review&reviewView=prepare"
          aria-current={preparation ? "page" : undefined}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-zinc-200"
        >
          {locale === "ko" ? "평가 준비" : "Prepare evaluation"}
        </Link>
        <Link
          href="/admin/analytics?tab=ai-review&reviewView=reports"
          prefetch={false}
          aria-current={!preparation ? "page" : undefined}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-zinc-200"
        >
          {locale === "ko"
            ? "실행 결과·운영 지표"
            : "Run results and operations"}
        </Link>
      </nav>
    );
    // Preparing criteria must not fetch or render observed evaluation scores.
    if (preparation)
      return (
        <div className="flex min-w-0 flex-col gap-5">
          {tabs}
          {reviewNavigation}
          <AdminAiReviewPreparationPanel
            catalog={readAiReviewPreparationCatalog()}
            locale={locale}
          />
          <AdminAiReviewThresholdDraft locale={locale} />
        </div>
      );
    // Read here rather than fetched by the panel: three windows over two
    // tables, and the tab is already a server component. Nothing on this tab
    // writes -- the reviewer-pair register is changed by a person in commit
    // history, and a screen that edited its own subject would erase the audit
    // trail the register exists for.
    const scorecards = await Promise.all(
      AI_REVIEW_SCORECARD_WINDOWS.map((windowDays) =>
        readAiReviewScorecard(windowDays),
      ),
    );
    const messages = await getAdminMessages(adminAiReviewJudgedMessages);
    const catalog = readAiReviewJudgedRunCatalog();
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs}
        {reviewNavigation}
        <AdminAiReviewM5Progress
          progress={aiReviewM5Progress(
            readAiReviewPreparationCatalog(),
            catalog,
          )}
          locale={locale}
        />
        <AdminAiReviewJudgedPanel catalog={catalog} locale={locale} />
        <details
          open
          className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5"
        >
          <summary className="cursor-pointer text-sm font-semibold text-zinc-200">
            {messages.operational}
          </summary>
          <div className="mt-5">
            <AdminAiReviewScorecardPanel scorecards={scorecards} />
          </div>
        </details>
      </div>
    );
  }

  const [dashboard, userStats, usersWithConversations, checkoutStartedCount] =
    await Promise.all([
      getProductAnalyticsDashboard(),
      getAdminUserStats(),
      prisma.conversation.groupBy({ by: ["userId"], _count: { _all: true } }),
      prisma.stripeWebhookEventLog.count({
        where: { eventType: "checkout.session.completed" },
      }),
    ]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs}
      <AdminProductAnalyticsPanel dashboard={dashboard} />
      <LaunchFunnelPanel
        funnel={{
          totalUsers: userStats.totalAccounts,
          usersWithConversations: usersWithConversations.length,
          usersWithPaidPlan: userStats.activePaidSubscriptions,
          checkoutStarted: checkoutStartedCount,
          paidUsers: userStats.activePaidSubscriptions,
        }}
      />
    </div>
  );
}
