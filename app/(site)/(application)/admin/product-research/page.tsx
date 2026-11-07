export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminProductResearchPanel } from "@/components/admin/AdminProductResearchPanel";
import { AdminScoutRunsPanel } from "@/components/admin/AdminScoutRunsPanel";
import { AdminScoutSuggestionsPanel } from "@/components/admin/AdminScoutSuggestionsPanel";
import { ScoutAgentHeader } from "@/components/admin/ScoutAgentHeader";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { EMPTY_ADMIN_NAVIGATION_COUNTS } from "@/lib/adminNavigationBadges";
import { scoutState } from "@/lib/adminScoutDisplay";
import { authOptions } from "@/lib/auth";
import { isProductResearchRouteEnabled } from "@/lib/productResearchObservationRouteAuth";
import { readProductResearchConsole } from "@/lib/productResearchConsoleRead";
import { readScoutConsole } from "@/lib/productResearchScoutConsoleRead";
import {
  PRODUCT_RESEARCH_SCOUT_SWITCH_ENV,
  nextScoutRunAt,
  scoutDays,
} from "@/lib/productResearchScoutCore";
import { readScoutSettings, scoutRecentCalls } from "@/lib/productResearchScoutSettings";
import { scoutTestAccountEmail } from "@/lib/productResearchScoutSignedIn";
import { suggestionCounts } from "@/lib/productResearchScoutStore";

const TABS = adminNavItemTabs("product-research");

/**
 * The product-research agent's workspace (docs/policy/product-research-agent.md
 * §4, §10): the Scout's open suggestions, its runs and spending, and the issue
 * observation record. It left the engineering agent's screen on 2026-10-19;
 * the old `/admin/engineering-agent?tab=product-research` link redirects here.
 *
 * Every tab opens under the agent's head (its face, state, next run and
 * switch). Only the open section's rows are loaded. Reading takes ordinary
 * admin authentication, which the console layout has established; dismissing,
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
      variant="underline"
    />
  );

  if (tab.id === "observations") {
    const [observations, counts, header] = await Promise.all([
      readProductResearchConsole(),
      // The tab badge only: a failed count shows no badge rather than a zero.
      suggestionCounts().catch(() => null),
      readScoutHeader(),
    ]);
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <ScoutAgentHeader {...header} />
        {tabs(counts?.open ?? null)}
        <AdminProductResearchPanel key={tab.id} initial={observations} />
      </div>
    );
  }

  const session = await getServerSession(authOptions);
  const scout = await readScoutConsole(session, tab.id === "runs" ? "runs" : "suggestions");
  const header = {
    state: scoutState(scout),
    // An agent that is off will not run: no next-run time is drawn for it.
    nextRunAt: scout.enabled ? scout.nextRunAt : null,
    testAccountConfigured: scout.testAccountConfigured,
  };
  // The side tiles' seven days: read on their own, null when they fail.
  const week = tab.id === "runs" ? undefined : await readWeek();
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <ScoutAgentHeader {...header} />
      {tabs(scout.counts.open)}
      {/* Keyed by section: a tab change remounts the panel with its own rows. */}
      {tab.id === "runs" ? (
        <AdminScoutRunsPanel key={tab.id} initial={scout} />
      ) : (
        <AdminScoutSuggestionsPanel key={tab.id} initial={scout} week={week} />
      )}
    </div>
  );
}

/** The last seven days of the Scout's calls, newest first; null when the ledger could not be read. */
async function readWeek() {
  try {
    return scoutDays(await scoutRecentCalls(7), new Date(), 7);
  } catch {
    console.warn({ event: "admin_product_research_read_failed", read: "scout_week" });
    return null;
  }
}

/**
 * What the head needs when the open tab did not read the Scout itself. Each
 * part is read on its own: a model or cap that cannot be read leaves the state
 * unknown (null) rather than guessing on or off.
 */
async function readScoutHeader() {
  const enabled = isProductResearchRouteEnabled(process.env, PRODUCT_RESEARCH_SCOUT_SWITCH_ENV);
  // Never throws: an unreadable settings store reads as off, which is how the agent itself acts.
  const settings = await readScoutSettings();
  return {
    state: !enabled ? ("off" as const) : scoutState({ enabled, settings }),
    nextRunAt: enabled ? nextScoutRunAt(new Date()).toISOString() : null,
    testAccountConfigured: scoutTestAccountEmail() !== null,
  };
}
