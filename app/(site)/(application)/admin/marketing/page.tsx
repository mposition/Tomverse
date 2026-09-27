export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminMarketingPanel } from "@/components/admin/AdminMarketingPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { hasAdminPermission } from "@/lib/adminAuth";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";
import { readMarketingConsole } from "@/lib/marketingConsoleRead";
import type { MarketingConsoleSection } from "@/lib/marketingConsoleSections";

const TABS = adminNavItemTabs("marketing");

/**
 * The marketing automation's record, read only
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
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  const initial = await readMarketingConsole(
    tab.id as MarketingConsoleSection,
    hasAdminPermission(session, "marketing:write")
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/marketing"
        tabs={TABS}
        activeTabId={tab.id}
        label="Marketing sections"
        query={query}
      />
      {/*
        Keyed by section so a client navigation between tabs remounts the
        panel with the new payload. Without it the panel's `useState(initial)`
        keeps the previous section's rows while the tab strip says otherwise,
        which is the section living in component state -- the thing the Admin
        IA contract's second rule forbids.
      */}
      <AdminMarketingPanel key={tab.id} initial={initial} />
    </div>
  );
}
