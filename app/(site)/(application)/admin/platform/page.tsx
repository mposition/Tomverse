export const dynamic = "force-dynamic";

import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { PlatformSettingsPanel } from "@/components/admin/PlatformSettingsPanel";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { readPlatformSettingsPanelProps } from "@/lib/adminPlatformSettingsRead";

const TABS = adminNavItemTabs("platform");

/**
 * Feature flags: emergency stops, feature switches and account defaults, one
 * section each (`?tab=emergency`, `features`, `account-defaults`). The default
 * models that used to sit here are the Default models tab of Models.
 *
 * Every section is the same panel drawing its part of one state, so the save
 * and its step-up behave as they did on the single screen.
 */
export default async function AdminPlatformSettingsPage({
  searchParams,
}: PageProps<"/admin/platform">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const props = await readPlatformSettingsPanelProps();

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/platform"
        tabs={TABS}
        activeTabId={tab.id}
        label="Feature flag sections"
        query={query}
      />
      <PlatformSettingsPanel
        key={tab.id}
        view={tab.id as "emergency" | "features" | "account-defaults"}
        {...props}
      />
    </div>
  );
}
