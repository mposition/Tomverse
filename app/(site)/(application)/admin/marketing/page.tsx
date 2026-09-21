export const dynamic = "force-dynamic";

import { AdminMarketingPanel } from "@/components/admin/AdminMarketingPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import type { MarketingConsoleSection } from "@/lib/marketingConsoleSections";

const TABS = adminNavItemTabs("marketing");

/**
 * The marketing automation's record, read only
 * (docs/policy/marketing-automation.md §6.1, §8).
 *
 * This slice adds no control that changes marketing state. Approving a draft,
 * pausing an account and marking a template reusable arrive in S2b1 with their
 * own permission and step-up; the queue below is what an operator reads to find
 * out what the automation did and what it is waiting for, and reading it takes
 * ordinary admin authentication.
 */
export default async function AdminMarketingPage({
  searchParams,
}: PageProps<"/admin/marketing">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/marketing"
        tabs={TABS}
        activeTabId={tab.id}
        label="Marketing sections"
        query={query}
      />
      <AdminMarketingPanel section={tab.id as MarketingConsoleSection} />
    </div>
  );
}
