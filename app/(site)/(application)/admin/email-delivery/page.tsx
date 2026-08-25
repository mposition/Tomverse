export const dynamic = "force-dynamic";

import { AdminEmailDeliveriesPanel } from "@/components/admin/AdminEmailDeliveriesPanel";
import { AdminEmailSuppressionsPanel } from "@/components/admin/AdminEmailSuppressionsPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import { AdminAddressRevealProvider } from "@/components/admin/AdminAddressReveal";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAdminRole } from "@/lib/adminAuth";
import { roleMayRevealAddresses } from "@/lib/emailAddressMaskingCore";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";
import {
  emailDeliveryStatusCounts,
  listEmailDeliveries,
  listSuppressions,
} from "@/lib/adminEmailDeliveries";
import { parseDeliveryFilters } from "@/lib/adminEmailDeliveryFilters";

const TABS = adminNavItemTabs("email-delivery");

/**
 * What was sent, and who we will not send to.
 *
 * Contract: docs/policy/email-notifications.md §9.5, §13.7.
 *
 * §9.5 made `status = "abandoned"` the dead-letter queue rather than a separate
 * table, on the grounds that moving a row scatters its context. That reasoning
 * only pays off if something reads them back with the context attached, and
 * until this page nothing did — no admin surface touched `EmailDelivery` at
 * all, which is also why the badge §9.5 asks for had nowhere to lead.
 *
 * Only the open tab is loaded. The two answer different questions and the
 * suppression list is small; querying both on every visit would be a query
 * nobody asked for.
 */
export default async function AdminEmailDeliveryPage({
  searchParams,
}: PageProps<"/admin/email-delivery">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  // Resolved here rather than in the client island: a browser deciding whether
  // it may reveal is a browser that can decide it may.
  const mayRevealAddresses = roleMayRevealAddresses(
    getAdminRole(await getServerSession(authOptions))
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminPageTabs
        basePath="/admin/email-delivery"
        tabs={TABS}
        activeTabId={tab.id}
        label="Email delivery sections"
        query={query}
      />
      {tab.id === "suppressions" ? (
        <AdminAddressRevealProvider>
          <AdminEmailSuppressionsPanel
            rows={await listSuppressions({ emailAddress: null, limit: 100 })}
            mayRevealAddresses={mayRevealAddresses}
          />
        </AdminAddressRevealProvider>
      ) : (
        await (async () => {
          const filters = parseDeliveryFilters(query);
          const [page, statusCounts] = await Promise.all([
            listEmailDeliveries(filters),
            emailDeliveryStatusCounts(),
          ]);
          return (
            <AdminAddressRevealProvider>
              <AdminEmailDeliveriesPanel
                rows={page.rows}
                filters={filters}
                statusCounts={statusCounts}
                nextCursor={page.nextCursor}
                mayRevealAddresses={mayRevealAddresses}
              />
            </AdminAddressRevealProvider>
          );
        })()
      )}
    </div>
  );
}
