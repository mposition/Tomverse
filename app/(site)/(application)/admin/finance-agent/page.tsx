export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { AdminBillingFinanceOpsDigestsPanel, type FinanceAgentSection } from "@/components/admin/AdminBillingFinanceOpsDigestsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminAgentHeader } from "@/components/admin/ui/AdminAgentHeader";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { hasAdminPermission } from "@/lib/adminAuth";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAgentPageMessages } from "@/lib/adminMessages/agentPage";
import { adminBillingFinanceAgentMessages } from "@/lib/adminMessages/billingFinanceAgent";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { formatAestDateTime } from "@/lib/adminUiCore";
import { authOptions } from "@/lib/auth";
import { financeFigures, financeHeadStatus } from "@/lib/billingFinanceAgentCore";
import { readBillingFinanceOpsConsole } from "@/lib/billingFinanceOpsConsoleRead";

const TABS = adminNavItemTabs("finance-agent");

/**
 * The billing and finance agent (docs/policy/billing-finance-ops.md): the
 * daily pending-price deadline digest, the agent switch and the monitor check.
 * It was a tab of Agent digests; `/admin/agent-digests?tab=billing-finance-ops`
 * redirects here.
 *
 * Three tabs under the agent's head (2026-11-07): Overview (figures, the
 * report calendar, the mode), Daily report (the recent digests) and Settings
 * (the switch and its two writes). All three draw one read of the agent's
 * record, and a failed read is shown as one, never as an empty page. Reading
 * takes ordinary admin authentication, which the console layout has
 * established; recording a control takes owner or ops and a recent sign-in,
 * checked by its route. The head's auto-run mark is a reading that links to
 * Settings, where the real switch is.
 */
export default async function AdminFinanceAgentPage({ searchParams }: PageProps<"/admin/finance-agent">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const session = await getServerSession(authOptions);
  const canWrite = hasAdminPermission(session, "ops:write");
  const [agent, copy] = await Promise.all([
    getAdminMessages(adminAgentPageMessages),
    getAdminMessages(adminBillingFinanceAgentMessages),
  ]);
  const initial = await readBillingFinanceOpsConsole(canWrite).catch(() => {
    console.warn({ event: "admin_finance_agent_read_failed" });
    return null;
  });
  const standing = financeHeadStatus(initial ? initial.control : null);
  const latest = initial ? financeFigures(initial.digests).latest : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminAgentHeader
        team="finance"
        name={copy.name}
        status={{ tone: standing.tone, label: agent.status[standing.status === "watching" ? "observing" : standing.status] }}
        description={copy.description}
        meta={[
          { icon: "calendar", label: copy.metaSchedule },
          ...(initial
            ? [
                {
                  icon: "mail" as const,
                  label: latest ? copy.metaReport(formatAestDateTime(latest.createdAt) ?? "-") : copy.metaNoReport,
                },
              ]
            : []),
        ]}
        autoRun={{ state: standing.autoRun, href: "/admin/finance-agent?tab=settings" }}
      />
      <AdminPageTabs
        basePath="/admin/finance-agent"
        tabs={TABS}
        activeTabId={tab.id}
        label="Billing and finance sections"
        query={query}
        variant="underline"
      />
      {initial ? (
        <AdminBillingFinanceOpsDigestsPanel key={tab.id} initial={initial} section={tab.id as FinanceAgentSection} />
      ) : (
        <AdminStateBlock kind="error" title={copy.readFailed} />
      )}
    </div>
  );
}
