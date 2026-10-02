export const dynamic = "force-dynamic";

import { AdminAgentDigestsPanel } from "@/components/admin/AdminAgentDigestsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { readAgentDigestConsole } from "@/lib/agentDigestConsoleRead";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("agent-digests");

/**
 * The common Agent digest area (docs/policy/qa-release-agent.md section 4):
 * one section per agent that stores digests. Only the open section is
 * loaded. Reading takes ordinary admin authentication, which the console
 * layout has established.
 */
export default async function AdminAgentDigestsPage({ searchParams }: PageProps<"/admin/agent-digests">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const initial = await readAgentDigestConsole();

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/agent-digests"
        tabs={TABS}
        activeTabId={tab.id}
        label="Agent digest sections"
        query={query}
      />
      <AdminAgentDigestsPanel key={tab.id} initial={initial} />
    </div>
  );
}
