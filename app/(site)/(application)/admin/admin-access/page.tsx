export const dynamic = "force-dynamic";

import { AdminAccessPanel } from "@/components/admin/AdminAccessPanel";
import { AdminOperationalReadinessPanel } from "@/components/admin/AdminOperationalReadinessPanel";
import { redirect } from "next/navigation";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { getConfiguredAdminAccessWithActivity } from "@/lib/adminAuth";
import {
  ADMIN_ADMIN_ACCESS_LEGACY_TABS,
  adminNavItemTabs,
  adminRedirectTarget,
  resolveAdminTab,
} from "@/lib/adminNavigation";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAccessMessages } from "@/lib/adminMessages/adminAccess";

const TABS = adminNavItemTabs("admin-access");

/**
 * Administrators and operational readiness. The audit integrity check is part
 * of the Audit log since 2026-11-07; its old `?tab=integrity` link redirects
 * there.
 */
export default async function AdminAccessPage({
  searchParams,
}: PageProps<"/admin/admin-access">) {
  const query = await searchParams;
  const legacy = typeof query.tab === "string" ? ADMIN_ADMIN_ACCESS_LEGACY_TABS[query.tab] : undefined;
  if (legacy) redirect(adminRedirectTarget(legacy, query));
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
      {tab.id === "administrators" ? (
        <AdminAccessPanel access={await getConfiguredAdminAccessWithActivity()} />
      ) : null}
    </div>
  );
}
