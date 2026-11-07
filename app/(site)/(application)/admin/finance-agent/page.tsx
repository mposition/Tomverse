export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminBillingFinanceOpsDigestsPanel } from "@/components/admin/AdminBillingFinanceOpsDigestsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminTabPlaceholder } from "@/components/admin/AdminTabPlaceholder";
import { hasAdminPermission } from "@/lib/adminAuth";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";
import { readBillingFinanceOpsConsole } from "@/lib/billingFinanceOpsConsoleRead";

const TABS = adminNavItemTabs("finance-agent");

/**
 * The billing and finance agent (docs/policy/billing-finance-ops.md): the
 * daily pending-price deadline digest, the agent switch and the monitor check.
 * It was a tab of Agent digests; `/admin/agent-digests?tab=billing-finance-ops`
 * redirects here.
 *
 * The existing panel is the Overview tab as it was; the other two tabs are
 * declared in the route table and wait for their screens. Reading takes
 * ordinary admin authentication, which the console layout has established;
 * recording a control takes owner or ops and a recent sign-in, checked by its
 * route.
 */
export default async function AdminFinanceAgentPage({ searchParams }: PageProps<"/admin/finance-agent">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  const canWrite = hasAdminPermission(session, "ops:write");

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/finance-agent"
        tabs={TABS}
        activeTabId={tab.id}
        label="Billing and finance sections"
        query={query}
      />
      {tab.id === "overview" ? (
        <AdminBillingFinanceOpsDigestsPanel key={tab.id} initial={await readBillingFinanceOpsConsole(canWrite)} />
      ) : (
        <AdminTabPlaceholder />
      )}
    </div>
  );
}
