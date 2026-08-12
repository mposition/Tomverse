export const dynamic = "force-dynamic";

import { AdminBillingLifecyclePanel } from "@/components/admin/AdminBillingLifecyclePanel";
import { RefundRequestsPanel } from "@/components/admin/RefundRequestsPanel";
import { ADMIN_READ_LIMITS, loadRefundRequestRows } from "@/lib/adminConsoleData";
import { getAdminUserStats } from "@/lib/adminUsers";
import { prisma } from "@/lib/prisma";

export default async function AdminRefundsPage() {
  const [rows, userStats, pendingRefunds, approvedRefunds, rejectedRefunds] =
    await Promise.all([
      loadRefundRequestRows(),
      getAdminUserStats(),
      prisma.refundRequest.count({ where: { status: "pending" } }),
      prisma.refundRequest.count({ where: { status: "approved" } }),
      prisma.refundRequest.count({ where: { status: "rejected" } }),
    ]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminBillingLifecyclePanel
        activePaidUsers={userStats.activePaidSubscriptions}
        activeSubscriptions={userStats.activePaidSubscriptions}
        pendingRefunds={pendingRefunds}
        approvedRefunds={approvedRefunds}
        rejectedRefunds={rejectedRefunds}
        cancelAtPeriodEnd={userStats.cancelingSubscriptions}
      />
      <RefundRequestsPanel rows={rows} rowLimit={ADMIN_READ_LIMITS.refunds} />
    </div>
  );
}
