export const dynamic = "force-dynamic";

import { AdminApprovalsPanel } from "@/components/admin/AdminApprovalsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { OperatorPlaybooksPanel, SupportAgePanel } from "@/components/admin/AdminRiskPanels";
import { AdminWorkQueuePanel } from "@/components/admin/AdminWorkQueuePanel";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { feedbackSlaRows, loadFeedbackRows } from "@/lib/adminConsoleData";
import { loadAdminWorkQueue } from "@/lib/adminWorkQueue";

const TABS = adminNavItemTabs("work-queue");

/**
 * Two sections, and only the open one is loaded.
 *
 * The Queue tab runs the work-queue aggregation; the Approvals tab renders the
 * approval panel, which fetches its own rows client-side. Neither pays for the
 * other, which is the point of putting the section in the URL.
 */
export default async function AdminWorkQueuePage({
  searchParams,
}: PageProps<"/admin/work-queue">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const now = new Date();

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/work-queue"
        tabs={TABS}
        activeTabId={tab.id}
        label="Work queue sections"
        query={query}
      />
      {tab.id === "approvals" ? (
        <AdminApprovalsPanel />
      ) : (
        <>
          <AdminWorkQueuePanel queue={await loadAdminWorkQueue(now)} now={now} />
          <SupportAgePanel
            slaRows={feedbackSlaRows(await loadFeedbackRows(), now)}
          />
          <OperatorPlaybooksPanel />
        </>
      )}
    </div>
  );
}
