export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { RefundRequestsPanel } from "@/components/admin/RefundRequestsPanel";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { ADMIN_READ_LIMITS, loadRefundRequestRows } from "@/lib/adminConsoleData";
import { hasAdminPermission } from "@/lib/adminAuth";
import { adminMessagesFor } from "@/lib/adminLocale";
import { getAdminLocale } from "@/lib/adminLocaleServer";
import { adminRefundsMessages } from "@/lib/adminMessages/refunds";
import { authOptions } from "@/lib/auth";

/**
 * The refund review queue. The rows are the newest requests only; the panel
 * says so on screen. A failed read is shown as a failed read, never as an
 * empty queue.
 */
export default async function AdminRefundsPage() {
  const [session, locale, rowsResult] = await Promise.all([
    getServerSession(authOptions),
    getAdminLocale(),
    Promise.allSettled([loadRefundRequestRows()]).then(([result]) => result),
  ]);
  const m = adminMessagesFor(adminRefundsMessages, locale);
  if (rowsResult.status === "rejected") console.error("Admin refunds read failed:", rowsResult.reason);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {rowsResult.status === "fulfilled" ? (
        <RefundRequestsPanel
          rows={rowsResult.value}
          rowLimit={ADMIN_READ_LIMITS.refunds}
          generatedAt={new Date().toISOString()}
          writable={hasAdminPermission(session, "billing:write")}
        />
      ) : (
        <AdminStateBlock kind="error" title={m.readFailed.title} detail={m.readFailed.detail} />
      )}
    </div>
  );
}
