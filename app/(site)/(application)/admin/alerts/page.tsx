export const dynamic = "force-dynamic";

import { AdminAlertPolicyPanel } from "@/components/admin/AdminAlertPolicyPanel";
import { AdminNotificationsPanel } from "@/components/admin/AdminNotificationsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminSlackTemplatesPanel } from "@/components/admin/AdminSlackTemplatesPanel";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("alerts");

/**
 * Alert policy, templates and the delivery log, one section at a time.
 *
 * All three used to render together, so opening the page to acknowledge one
 * failed delivery also mounted two editable forms and issued their fetches.
 */
export default async function AdminAlertsPage({
  searchParams,
}: PageProps<"/admin/alerts">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/alerts"
        tabs={TABS}
        activeTabId={tab.id}
        label="Alert sections"
        query={query}
      />
      {tab.id === "templates" ? <AdminSlackTemplatesPanel /> : null}
      {tab.id === "deliveries" ? <AdminNotificationsPanel /> : null}
      {tab.id === "policy" ? <AdminAlertPolicyPanel /> : null}
    </div>
  );
}
