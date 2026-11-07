import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminBillingLifecycleMessages } from "@/lib/adminMessages/billingLifecycle";

/**
 * A count that could not be read is `null`, never 0: a refund queue of "0"
 * would tell the operator nothing is waiting.
 */
type Props = {
  activePaidUsers: number | null;
  activeSubscriptions: number | null;
  pendingRefunds: number | null;
  approvedRefunds: number | null;
  rejectedRefunds: number | null;
  cancelAtPeriodEnd: number | null;
};

export async function AdminBillingLifecyclePanel({
  activePaidUsers,
  activeSubscriptions,
  pendingRefunds,
  approvedRefunds,
  rejectedRefunds,
  cancelAtPeriodEnd,
}: Props) {
  const m = await getAdminMessages(adminBillingLifecycleMessages);
  return (
    <AdminTile title={m.title} description={m.description} data-testid="billing-lifecycle">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <AdminKpiCard
          label={m.paidUsers}
          value={activePaidUsers}
          detail={m.paidUsersDetail(activeSubscriptions)}
        />
        <AdminKpiCard
          label={m.canceling}
          value={cancelAtPeriodEnd}
          detail={m.cancelingDetail}
        />
        <AdminKpiCard
          label={m.refundQueue}
          value={pendingRefunds}
          detail={m.refundQueueDetail(approvedRefunds, rejectedRefunds)}
          tone={pendingRefunds !== null && pendingRefunds > 0 ? "warn" : "neutral"}
        />
        <AdminKpiCard
          label={m.paymentState}
          value={
            activeSubscriptions === null
              ? null
              : activeSubscriptions > 0
                ? m.paymentStateLive
                : m.paymentStateWatch
          }
          detail={m.paymentStateDetail}
        />
      </div>
    </AdminTile>
  );
}
