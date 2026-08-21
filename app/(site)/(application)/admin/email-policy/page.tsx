export const dynamic = "force-dynamic";

import { AdminEmailDomainsPanel } from "@/components/admin/AdminEmailDomainsPanel";
import { AdminEmailPolicyPanel } from "@/components/admin/AdminEmailPolicyPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import { readSendingDomainReport } from "@/lib/emailSendingDomains";

const TABS = adminNavItemTabs("email-policy");

/**
 * Two sections that answer two different questions about outbound mail: what
 * the rules are, and whether the domains they are sent from actually work.
 *
 * Only the open one is loaded. The domain section makes a request to the mail
 * provider, and paying for that on every visit to the jurisdiction list would
 * be a call nobody asked for, on a screen that is mostly read.
 */
export default async function AdminEmailPolicyPage({
  searchParams,
}: PageProps<"/admin/email-policy">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/email-policy"
        tabs={TABS}
        activeTabId={tab.id}
        label="Email policy sections"
        query={query}
      />
      {tab.id === "domains" ? (
        <AdminEmailDomainsPanel report={await readSendingDomainReport()} />
      ) : (
        <AdminEmailPolicyPanel />
      )}
    </div>
  );
}
