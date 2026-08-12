export const dynamic = "force-dynamic";

import { AdminAuditPanel } from "@/components/admin/AdminAuditPanel";
import { ADMIN_READ_LIMITS, loadAuditRows } from "@/lib/adminConsoleData";

export default async function AdminAuditPage() {
  return (
    <AdminAuditPanel
      rows={await loadAuditRows()}
      rowLimit={ADMIN_READ_LIMITS.auditLog}
    />
  );
}
