export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminMarketingFeatureFactsPanel } from "@/components/admin/AdminMarketingFeatureFactsPanel";
import { AdminMarketingPanel } from "@/components/admin/AdminMarketingPanel";
import { AdminPageTabs, type AdminPageTabChip } from "@/components/admin/AdminPageTabs";
import { AdminViewSwitch } from "@/components/admin/AdminViewSwitch";
import { hasAdminPermission } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminUiMessages } from "@/lib/adminMessages/ui";
import {
  ADMIN_MARKETING_LEGACY_TABS,
  adminNavItemTabs,
  adminRedirectTarget,
  resolveAdminTab,
  resolveAdminView,
} from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";
import { readMarketingAgentOverview } from "@/lib/marketingAgentOverviewRead";
import { readMarketingConsole } from "@/lib/marketingConsoleRead";
import { marketingFeatureRefreshModelId, readMarketingFeatureFacts } from "@/lib/marketingFeatureFacts";
import { prisma } from "@/lib/prisma";
import type { MarketingConsoleSection } from "@/lib/marketingConsoleSections";

const TABS = adminNavItemTabs("marketing");

/**
 * The redesign's tabs and the console sections behind them (2026-11-07).
 *
 * Approvals and Reports & competitors each still hold the old sections that
 * have no tab of their own, as views of the tab (`?view=`): Approvals the
 * drafts, the assets and the comment alerts, Reports the reports, the
 * competitors and the experiments. Overview and Settings draw the parts of the
 * old screen that were always on every section: the overview strip and the
 * settings rail. Every old `?tab=` link lands on its view
 * (ADMIN_MARKETING_LEGACY_TABS), so no section is unreachable.
 */
const QUEUE_VIEWS = ["drafts", "assets", "comments"] as const;
const REPORT_VIEWS = ["reports", "competitors", "experiments"] as const;
/** Settings: the switches and webhook rail, and the ad facts the box's Higgsfield job reads (2026-11-12). */
const SETTINGS_VIEWS = ["switches", "features"] as const;

/**
 * The marketing automation's record
 * (docs/policy/marketing-automation.md §6.1, §8).
 *
 * The rows are loaded here and rendered into the HTML rather than fetched
 * after hydration, so the page an operator opens is the page they can read.
 * The panel's refresh control calls `GET /api/admin/marketing`, which runs the
 * same loader.
 *
 * Reading takes ordinary admin authentication, which the console layout has
 * already established. The controls S2b1 adds -- approving a draft, pausing an
 * account, marking a template reusable -- take `marketing:write` and a recent
 * sign-in, and each route checks both again. Which of the two this viewer is
 * travels with the payload, so a reader who may only read is not offered
 * buttons that can only refuse.
 */
export default async function AdminMarketingPage({
  searchParams,
}: PageProps<"/admin/marketing">) {
  const query = await searchParams;
  const legacy = typeof query.tab === "string" ? ADMIN_MARKETING_LEGACY_TABS[query.tab] : undefined;
  if (legacy) redirect(adminRedirectTarget(legacy, query));
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  const ui = await getAdminMessages(adminUiMessages);

  // Which old section's data the tab draws, and which part of the old screen.
  const queueView = resolveAdminView(QUEUE_VIEWS, query.view);
  const reportView = resolveAdminView(REPORT_VIEWS, query.view);
  const settingsView = resolveAdminView(SETTINGS_VIEWS, query.view);
  const adFacts = tab.id === "settings" && settingsView === "features";
  const section: MarketingConsoleSection =
    tab.id === "queue" ? (queueView === "drafts" ? "queue" : queueView)
    : tab.id === "reports" ? reportView
    : tab.id === "published" ? "published"
    : tab.id === "accounts" ? "accounts"
    : "queue";
  // The ad facts view draws the head and tabs only (`overview` without the
  // agent read) and its own panel under them.
  const part = tab.id === "overview" || adFacts ? "overview" : tab.id === "settings" ? "settings" : "section";
  // The Overview's extra reads (posts per day, the schedule, recent runs) are
  // read-only and load for that tab alone; each part is null when unreadable.
  const canWrite = hasAdminPermission(session, "marketing:write");
  const [initial, agent, facts] = await Promise.all([
    readMarketingConsole(section, canWrite),
    tab.id === "overview" ? readMarketingAgentOverview() : Promise.resolve(undefined),
    // Unreadable is null, drawn as unavailable, never as an empty list.
    adFacts
      ? readMarketingFeatureFacts(prisma)
          .then((rows) => rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })))
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  // What each tab holds, from the overview the loader already read: the
  // drafts waiting for a person (in the attention colour) and the accounts.
  // An unreadable count draws nothing.
  const { pending, accounts } = initial.overview;
  const chips: Record<string, AdminPageTabChip | undefined> = {
    queue: pending && pending.count > 0 ? { label: String(pending.count), attention: true } : undefined,
    accounts: accounts && accounts.total > 0 ? { label: String(accounts.total) } : undefined,
  };
  // The strip carries no `view`: switching tab starts that tab on its first view.
  const tabQuery = { ...query, view: undefined };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/*
        Keyed by section and part so a client navigation between tabs remounts
        the panel with the new payload. Without it the panel's
        useState(initial) keeps the previous section's rows while the tab
        strip says otherwise, which is the section living in component state --
        the thing the Admin IA contract's second rule forbids. The strip is
        still a server component and still links ?tab=; the panel only
        places it under its overview.
      */}
      <AdminMarketingPanel
        key={`${section}-${part}-${adFacts ? "features" : ""}`}
        initial={initial}
        agent={agent}
        part={part}
        tabs={
          <>
            <AdminPageTabs
              basePath="/admin/marketing"
              tabs={TABS}
              activeTabId={tab.id}
              label="Marketing sections"
              query={tabQuery}
              chips={chips}
              variant="underline"
            />
            {tab.id === "queue" ? (
              <AdminViewSwitch
                basePath="/admin/marketing"
                tabId="queue"
                query={tabQuery}
                activeId={queueView}
                views={[
                  { id: "drafts", label: ui.view.approvals },
                  { id: "assets", label: ui.view.assets },
                  { id: "comments", label: ui.view.comments },
                ]}
              />
            ) : null}
            {tab.id === "settings" ? (
              <AdminViewSwitch
                basePath="/admin/marketing"
                tabId="settings"
                query={tabQuery}
                activeId={settingsView}
                views={[
                  { id: "switches", label: ui.view.switches },
                  { id: "features", label: ui.view.adFacts },
                ]}
              />
            ) : null}
            {tab.id === "reports" ? (
              <AdminViewSwitch
                basePath="/admin/marketing"
                tabId="reports"
                query={tabQuery}
                activeId={reportView}
                views={[
                  { id: "reports", label: ui.view.reports },
                  { id: "competitors", label: ui.view.competitors },
                  { id: "experiments", label: ui.view.experiments },
                ]}
              />
            ) : null}
          </>
        }
      />
      {adFacts ? (
        <AdminMarketingFeatureFactsPanel
          initial={facts}
          canWrite={canWrite}
          refreshModelId={marketingFeatureRefreshModelId()}
        />
      ) : null}
    </div>
  );
}
