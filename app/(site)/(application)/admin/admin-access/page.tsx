export const dynamic = "force-dynamic";

import { AdminAccessPanel } from "@/components/admin/AdminAccessPanel";
import { AdminAuditIntegrityPanel } from "@/components/admin/AdminAuditIntegrityPanel";
import { AdminOperationalReadinessPanel } from "@/components/admin/AdminOperationalReadinessPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { getConfiguredAdminAccessWithActivity } from "@/lib/adminAuth";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("admin-access");

export default async function AdminAccessPage({
  searchParams,
}: PageProps<"/admin/admin-access">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/admin-access"
        tabs={TABS}
        activeTabId={tab.id}
        label="Admin access sections"
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
