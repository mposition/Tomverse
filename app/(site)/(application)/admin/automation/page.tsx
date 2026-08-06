export const dynamic = "force-dynamic";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminReportsPanel } from "@/components/admin/AdminReportsPanel";
import { AdminScheduledJobsPanel } from "@/components/admin/AdminScheduledJobsPanel";
import { AdminWebhookPanel } from "@/components/admin/AdminWebhookPanel";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("automation");

/**
 * Scheduled jobs, webhooks and operations reports under one entry.
 *
 * All three are "work the platform does on a timer or a trigger, that an
 * operator supervises rather than performs". They were three sidebar entries --
 * and Reports had no entry at all, appearing only underneath the webhook table
 * where nothing named it.
 */
export default async function AdminAutomationPage({
  searchParams,
}: PageProps<"/admin/automation">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/automation"
        tabs={TABS}
        activeTabId={tab.id}
        label="Automation sections"
        query={query}
      />
      {tab.id === "webhooks" ? <AdminWebhookPanel /> : null}
      {tab.id === "reports" ? <AdminReportsPanel /> : null}
      {tab.id === "jobs" ? <AdminScheduledJobsPanel /> : null}
    </div>
  );
}
