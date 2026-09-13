export const dynamic = "force-dynamic";

import { AdminAccessPanel } from "@/components/admin/AdminAccessPanel";
import { AdminAuditIntegrityPanel } from "@/components/admin/AdminAuditIntegrityPanel";
import { AdminOperationalReadinessPanel } from "@/components/admin/AdminOperationalReadinessPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { getConfiguredAdminAccessWithActivity } from "@/lib/adminAuth";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAccessMessages } from "@/lib/adminMessages/adminAccess";

const TABS = adminNavItemTabs("admin-access");

export default async function AdminAccessPage({
  searchParams,
}: PageProps<"/admin/admin-access">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const m = await getAdminMessages(adminAccessMessages);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/admin-access"
        tabs={TABS}
        activeTabId={tab.id}
        label={m.tabsLabel}
        query={query}
      />
      {tab.id === "readiness" ? <AdminOperationalReadinessPanel /> : null}
      {tab.id === "integrity" ? <AdminAuditIntegrityPanel /> : null}
      {tab.id === "administrators" ? (
        <AdminAccessPanel access={await getConfiguredAdminAccessWithActivity()} />
      ) : null}
    </div>
  );
}
