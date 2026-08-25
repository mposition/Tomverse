export const dynamic = "force-dynamic";

import { AdminAuditPanel } from "@/components/admin/AdminAuditPanel";
import {
  ADMIN_READ_LIMITS,
  loadAuditRowById,
  loadAuditRows,
} from "@/lib/adminConsoleData";

/**
 * The audit workspace, and one row named in the URL.
 *
 * Contract: docs/ui-contracts/admin-console-ia.md.
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
  const requested = (Array.isArray(query.entry) ? query.entry[0] : query.entry)
    ?.trim();

  const [rows, requestedEntry] = await Promise.all([
    loadAuditRows(),
    requested ? loadAuditRowById(requested) : Promise.resolve(null),
  ]);

  return (
    <AdminAuditPanel
      rows={rows}
      rowLimit={ADMIN_READ_LIMITS.auditLog}
      requestedEntryId={requested || null}
      requestedEntry={requestedEntry}
    />
  );
}
