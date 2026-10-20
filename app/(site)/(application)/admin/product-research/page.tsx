export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminProductResearchPanel } from "@/components/admin/AdminProductResearchPanel";
import { AdminScoutRunsPanel } from "@/components/admin/AdminScoutRunsPanel";
import { AdminScoutSuggestionsPanel } from "@/components/admin/AdminScoutSuggestionsPanel";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { EMPTY_ADMIN_NAVIGATION_COUNTS } from "@/lib/adminNavigationBadges";
import { authOptions } from "@/lib/auth";
import { readProductResearchConsole } from "@/lib/productResearchConsoleRead";
import { readScoutConsole } from "@/lib/productResearchScoutConsoleRead";
import { suggestionCounts } from "@/lib/productResearchScoutStore";

const TABS = adminNavItemTabs("product-research");

/**
 * The product-research agent's workspace (docs/policy/product-research-agent.md
 * §4, §10): the Scout's open suggestions, its runs and spending, and the issue
 * observation record. It left the engineering agent's screen on 2026-10-19;
 * the old `/admin/engineering-agent?tab=product-research` link redirects here.
 *
 * Only the open section's rows are loaded. Reading takes ordinary admin
 * authentication, which the console layout has established; dismissing,
 * sending and changing the model or cap each check role and a recent sign-in
 * again in their own routes.
 */
export default async function AdminProductResearchPage({
  searchParams,
}: PageProps<"/admin/product-research">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const tabs = (openProductResearchSuggestions: number | null) => (
    <AdminPageTabs
      basePath="/admin/product-research"
      tabs={TABS}
      activeTabId={tab.id}
      label="Product research sections"
      query={query}
      counts={{ ...EMPTY_ADMIN_NAVIGATION_COUNTS, openProductResearchSuggestions }}
    />
  );

  if (tab.id === "observations") {
    const [observations, counts] = await Promise.all([
      readProductResearchConsole(),
      // The tab badge only: a failed count shows no badge rather than a zero.
      suggestionCounts().catch(() => null),
    ]);
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {tabs(counts?.open ?? null)}
        <AdminProductResearchPanel key={tab.id} initial={observations} />
      </div>
    );
  }

  const session = await getServerSession(authOptions);
  const scout = await readScoutConsole(session, tab.id === "runs" ? "runs" : "suggestions");
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {tabs(scout.counts.open)}
      {/* Keyed by section: a tab change remounts the panel with its own rows. */}
      {tab.id === "runs" ? (
        <AdminScoutRunsPanel key={tab.id} initial={scout} />
      ) : (
        <AdminScoutSuggestionsPanel key={tab.id} initial={scout} />
      )}
    </div>
  );
}
