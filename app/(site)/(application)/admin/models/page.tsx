export const dynamic = "force-dynamic";

import { AdminModelDiscoveryPanel } from "@/components/admin/AdminModelDiscoveryPanel";
import { AdminModelRegistryPanel } from "@/components/admin/AdminModelRegistryPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("models");

/**
 * Two sections, and only the open one is mounted.
 *
 * The registry was previously the whole page; discovery joins it here rather
 * than as its own route because they are one subject -- what the catalogue
 * serves, and what a provider offered that it does not. Splitting them would
 * have put the backlog somewhere an operator has no reason to visit, which is
 * the state it was already in.
 *
 * Both panels fetch their own rows, so the section in `?tab=` decides which
 * request is made at all.
 */
export default async function AdminModelsPage({
  searchParams,
}: PageProps<"/admin/models">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/models"
        tabs={TABS}
        activeTabId={tab.id}
        label="Model sections"
        query={query}
      />
      {tab.id === "discovery" ? (
        <AdminModelDiscoveryPanel />
      ) : (
        <AdminModelRegistryPanel />
      )}
    </div>
  );
}
