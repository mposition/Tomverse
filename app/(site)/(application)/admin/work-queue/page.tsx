export const dynamic = "force-dynamic";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { OperatorPlaybooksPanel, SupportAgePanel } from "@/components/admin/AdminRiskPanels";
import { AdminTabPlaceholder } from "@/components/admin/AdminTabPlaceholder";
import { AdminWorkQueuePanel } from "@/components/admin/AdminWorkQueuePanel";
import { feedbackSlaRows, loadFeedbackRows } from "@/lib/adminConsoleData";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { loadAdminWorkQueue } from "@/lib/adminWorkQueue";

const TABS = adminNavItemTabs("work-queue");

/**
 * Decisions: one list of work that is actually waiting on a person.
 *
 * Two-person approval used to be a second tab. It is not a queue anymore:
 * an eligible administrator executes the action, and the audit log is the
 * record. `/admin/approvals` redirects here.
 *
 * The area tabs are declared in the route table (2026-11-07). The All tab is
 * the queue as it was; the four areas wait for the screen that gathers the
 * decisions now spread over the agent and AMUX pages, and say so.
 */
export default async function AdminWorkQueuePage({ searchParams }: PageProps<"/admin/work-queue">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const now = new Date();

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/work-queue"
        tabs={TABS}
        activeTabId={tab.id}
        label="Decision sections"
        query={query}
      />
      {tab.id === "all" ? (
        <>
          <AdminWorkQueuePanel queue={await loadAdminWorkQueue(now)} now={now} />
          <SupportAgePanel slaRows={feedbackSlaRows(await loadFeedbackRows(), now)} />
          <OperatorPlaybooksPanel />
        </>
      ) : (
        <AdminTabPlaceholder />
      )}
    </div>
  );
}
