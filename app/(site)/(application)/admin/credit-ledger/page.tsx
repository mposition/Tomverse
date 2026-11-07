export const dynamic = "force-dynamic";

import { AdminCreditLedgerPanel } from "@/components/admin/AdminCreditLedgerPanel";
import { ADMIN_READ_LIMITS } from "@/lib/adminConsoleData";
import { prisma } from "@/lib/prisma";

export default async function AdminCreditLedgerPage() {
  // Two independent reads: a failure in one must not blank the other, and a
  // failed read is passed on as `null` so the screen never draws it as empty.
  const [entriesResult, owedResult] = await Promise.allSettled([
    prisma.creditLedgerEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: ADMIN_READ_LIMITS.creditLedger,
      include: { user: { select: { email: true } } },
    }),
    prisma.user.aggregate({
      where: { creditDebtCredits: { gt: 0 } },
      _sum: { creditDebtCredits: true },
      _count: { _all: true },
    }),
  ]);
  if (entriesResult.status === "rejected") console.error("Admin credit ledger read failed:", entriesResult.reason);
  if (owedResult.status === "rejected") console.error("Admin credit debt read failed:", owedResult.reason);

  return (
    <AdminCreditLedgerPanel
      rowLimit={ADMIN_READ_LIMITS.creditLedger}
      owed={
        owedResult.status === "fulfilled"
          ? {
              credits: owedResult.value._sum.creditDebtCredits ?? 0,
              customers: owedResult.value._count._all,
            }
          : null
      }
      rows={
        entriesResult.status === "fulfilled"
          ? entriesResult.value.map((entry) => ({
              id: entry.id,
              userId: entry.userId,
              userEmail: entry.user.email,
              type: entry.type,
              creditsDelta: entry.creditsDelta,
              balanceAfterCredits: entry.balanceAfterCredits,
              fundedCostMicroUsdDelta: Number(entry.fundedCostMicroUsdDelta),
              reservationId: entry.reservationId,
              createdAt: entry.createdAt.toISOString(),
            }))
          : null
      }
    />
  );
}
