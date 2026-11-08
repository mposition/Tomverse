export const dynamic = "force-dynamic";

import { AdminAuditIntegrityPanel } from "@/components/admin/AdminAuditIntegrityPanel";
import { AdminAuditPanel } from "@/components/admin/AdminAuditPanel";
import { AdminPageTabs } from "@/components/admin/AdminPageTabs";
import {
  ADMIN_READ_LIMITS,
  loadAuditRowById,
  loadAuditRows,
} from "@/lib/adminConsoleData";
import { adminNavItemTabs, resolveAdminTab } from "@/lib/adminNavigation";

const TABS = adminNavItemTabs("audit");

/**
 * The audit workspace, and one row named in the URL.
 *
 * Contract: docs/ui-contracts/admin-console-ia.md.
 *
 * Two sections (2026-11-07): the records (`?tab=log`, the default) and the
 * integrity check of the chain they form (`?tab=integrity`), which was a tab of
 * Admin access; its old link redirects here. Only the open section is read.
 *
 * `?entry=<id>` exists because the integrity checker answers a failure with an
 * id and nothing could take it. The panel lists the newest
 * `ADMIN_READ_LIMITS.auditLog` rows and the checker walks oldest-first, stopping
 * at the first bad one — so the row an operator needs is the one that window
 * does not hold. The id is resolved here, on the server, so a directly-opened
 * link works: it is the same read the single-row API does, and it does not
 * depend on the row being on screen already.
 *
 * A `?entry=` that resolves to nothing is not a 404. The workspace exists and
 * the operator is looking at it; what is missing is one row, and the panel says
 * that on screen. Answering 404 for the whole page would say the wrong thing.
 */
export default async function AdminAuditPage({
  searchParams,
}: PageProps<"/admin/audit">) {
  const query = await searchParams;
  const tab = resolveAdminTab(TABS, query.tab);
  const strip = (
    <AdminPageTabs
      basePath="/admin/audit"
      tabs={TABS}
      activeTabId={tab.id}
      label="Audit log sections"
      query={query}
    />
  );

  if (tab.id === "integrity") {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {strip}
        <AdminAuditIntegrityPanel />
      </div>
    );
  }

  const requested = (Array.isArray(query.entry) ? query.entry[0] : query.entry)
    ?.trim();

  const [rows, requestedEntry] = await Promise.all([
    loadAuditRows(),
    requested ? loadAuditRowById(requested) : Promise.resolve(null),
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {strip}
      <AdminAuditPanel
        rows={rows}
        rowLimit={ADMIN_READ_LIMITS.auditLog}
        requestedEntryId={requested || null}
        requestedEntry={requestedEntry}
      />
    </div>
  );
}
