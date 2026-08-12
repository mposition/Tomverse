export const dynamic = "force-dynamic";

import { AdminCreditLedgerPanel } from "@/components/admin/AdminCreditLedgerPanel";
import { ADMIN_READ_LIMITS } from "@/lib/adminConsoleData";
import { prisma } from "@/lib/prisma";

export default async function AdminCreditLedgerPage() {
  const entries = await prisma.creditLedgerEntry.findMany({
    orderBy: { createdAt: "desc" },
    take: ADMIN_READ_LIMITS.creditLedger,
    include: { user: { select: { email: true } } },
  });

  return (
    <AdminCreditLedgerPanel
      rowLimit={ADMIN_READ_LIMITS.creditLedger}
      rows={entries.map((entry) => ({
        id: entry.id,
        userId: entry.userId,
        userEmail: entry.user.email,
        type: entry.type,
        creditsDelta: entry.creditsDelta,
        balanceAfterCredits: entry.balanceAfterCredits,
        fundedCostMicroUsdDelta: Number(entry.fundedCostMicroUsdDelta),
        reservationId: entry.reservationId,
        createdAt: entry.createdAt.toISOString(),
      }))}
    />
  );
}
