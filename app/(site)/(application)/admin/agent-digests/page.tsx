export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminAgentDigestsPanel } from "@/components/admin/AdminAgentDigestsPanel";
import { AdminBillingFinanceOpsDigestsPanel } from "@/components/admin/AdminBillingFinanceOpsDigestsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { readAgentDigestConsole } from "@/lib/agentDigestConsoleRead";
import { readBillingFinanceOpsConsole } from "@/lib/billingFinanceOpsConsoleRead";
import { hasAdminPermission } from "@/lib/adminAuth";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("agent-digests");

/**
 * The common Agent digest area (docs/policy/qa-release-agent.md section 4):
 * one section per agent that stores digests. Only the open section is
 * loaded. Reading takes ordinary admin authentication, which the console
 * layout has established; recording a control revision takes owner or ops
 * and a recent sign-in, checked by its route.
 */
export default async function AdminAgentDigestsPage({ searchParams }: PageProps<"/admin/agent-digests">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  // Whether this viewer may write travels with the payload, so a reader is not
  // offered a form that can only refuse; the routes check again. Only the open
  // tab's data is loaded.
  const canWrite = hasAdminPermission(session, "ops:write");

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/agent-digests"
        tabs={TABS}
        activeTabId={tab.id}
        label="Agent digest sections"
        query={query}
      />
      {tab.id === "billing-finance-ops" ? (
        <AdminBillingFinanceOpsDigestsPanel key={tab.id} initial={await readBillingFinanceOpsConsole(canWrite)} />
      ) : (
        <AdminAgentDigestsPanel key={tab.id} initial={await readAgentDigestConsole(canWrite)} />
      )}
    </div>
  );
}
