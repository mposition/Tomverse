export const dynamic = "force-dynamic";

import { AdminCampaignSchedulePanel } from "@/components/admin/AdminCampaignSchedulePanel";
import { AdminEmailCampaignsPanel } from "@/components/admin/AdminEmailCampaignsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import {
  listAdminCampaigns,
  listCampaignSchedule,
} from "@/lib/adminEmailCampaigns";

const TABS = adminNavItemTabs("email-campaigns");

/** Bounded, and both panels say so on screen rather than only here. */
const LIMIT = 100;

/**
 * Campaigns, and the waves that have a time.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3.
 *
 * Two sections because they answer two questions an operator asks separately:
 * "what am I working on" and "what should already have gone out". The second
 * cannot be answered from the first without opening every campaign, which is
 * why an overdue wave had nowhere to appear -- nothing in the console read
 * `EmailCampaignWave` at all.
 *
 * Only the open section is loaded. Neither read is expensive, but a page that
 * loads both teaches the next section added here to do the same.
 */
export default async function AdminEmailCampaignsPage({
  searchParams,
}: PageProps<"/admin/email-campaigns">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/email-campaigns"
        tabs={TABS}
        activeTabId={tab.id}
        label="Email campaign sections"
        query={query}
      />
      {tab.id === "schedule" ? (
        <AdminCampaignSchedulePanel
          rows={await listCampaignSchedule({ limit: LIMIT })}
          limit={LIMIT}
        />
      ) : (
        <AdminEmailCampaignsPanel
          rows={await listAdminCampaigns({ limit: LIMIT })}
          limit={LIMIT}
        />
      )}
    </div>
  );
}
