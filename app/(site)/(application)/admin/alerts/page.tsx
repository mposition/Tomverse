export const dynamic = "force-dynamic";

import { AdminAlertPolicyPanel } from "@/components/admin/AdminAlertPolicyPanel";
import { AdminNotificationsPanel } from "@/components/admin/AdminNotificationsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminOperatorAlertProbePanel } from "@/components/admin/AdminOperatorAlertProbePanel";
import { AdminSlackTemplatesPanel } from "@/components/admin/AdminSlackTemplatesPanel";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("alerts");

/**
 * Alert policy, templates, the delivery log and the mail path test, one
 * section at a time.
 *
 * All of them used to render together, so opening the page to acknowledge one
 * failed delivery also mounted two editable forms and issued their fetches.
 * The mail path test (`?tab=mail-test`) was under Templates until 2026-11-07.
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
      {tab.id === "mail-test" ? <AdminOperatorAlertProbePanel /> : null}
      {tab.id === "deliveries" ? <AdminNotificationsPanel /> : null}
      {tab.id === "policy" ? <AdminAlertPolicyPanel /> : null}
    </div>
  );
}
