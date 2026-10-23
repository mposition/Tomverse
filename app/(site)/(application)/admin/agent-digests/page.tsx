export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminBillingFinanceOpsDigestsPanel } from "@/components/admin/AdminBillingFinanceOpsDigestsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { readBillingFinanceOpsConsole } from "@/lib/billingFinanceOpsConsoleRead";
import { hasAdminPermission } from "@/lib/adminAuth";
import {
  ADMIN_AGENT_DIGESTS_LEGACY_TABS,
  adminNavItemTabs,
  adminRedirectTarget,
  resolveAdminTab,
} from "@/lib/adminNavigation";
import { authOptions } from "@/lib/auth";

const TABS = adminNavItemTabs("agent-digests");

/**
 * The common Agent digest area: one section per agent that stores digests.
 * QA and release, and CI admission, moved to /admin/qa-release; their old
 * links redirect there. Reading takes ordinary admin authentication, which
 * the console layout has established; recording a control revision takes
 * owner or ops and a recent sign-in, checked by its route.
 */
export default async function AdminAgentDigestsPage({ searchParams }: PageProps<"/admin/agent-digests">) {
  const query = await searchParams;
  const legacy = typeof query.tab === "string" ? ADMIN_AGENT_DIGESTS_LEGACY_TABS[query.tab] : undefined;
  if (legacy) redirect(adminRedirectTarget(legacy, query));
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
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
      <AdminBillingFinanceOpsDigestsPanel key={tab.id} initial={await readBillingFinanceOpsConsole(canWrite)} />
    </div>
  );
}
