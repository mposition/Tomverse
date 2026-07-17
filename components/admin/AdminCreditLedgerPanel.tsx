import Link from "next/link";
import { CircleDollarSign } from "lucide-react";

export type AdminCreditLedgerRow = {
  id: string;
  userId: string;
  userEmail: string | null;
  type: string;
  creditsDelta: number;
  balanceAfterCredits: number;
  fundedCostMicroUsdDelta: number;
  reservationId: string | null;
  createdAt: string;
};

const dateLabel = (value: string) =>
  new Date(value).toISOString().replace("T", " ").slice(0, 16);

export function AdminCreditLedgerPanel({ rows }: { rows: AdminCreditLedgerRow[] }) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-blue-300"><CircleDollarSign className="h-4 w-4" /> Credit ledger</div>
          <h2 className="mt-2 text-xl font-black text-white">Recent credit movements</h2>
          <p className="mt-1 text-sm text-zinc-500">Reserve, settlement, refund, purchase, expiry, and administrative entries. Open a customer for the complete account timeline.</p>
        </div>
        <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-bold text-zinc-400">Latest {rows.length}</span>
      </div>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[840px] text-left text-sm">
          <thead className="text-[10px] uppercase tracking-[0.16em] text-zinc-600">
            <tr>{["Created", "Customer", "Type", "Change", "Balance", "Funded cost", "Reservation"].map((label) => <th key={label} className="px-3 py-2">{label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-zinc-800 text-zinc-300">
                <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-500">{dateLabel(row.createdAt)} UTC</td>
                <td className="max-w-64 px-3 py-3"><Link href={`/admin/users/${encodeURIComponent(row.userId)}`} className="block truncate font-black text-blue-300 hover:text-blue-200">{row.userEmail || row.userId}</Link></td>
                <td className="px-3 py-3"><span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-bold">{row.type}</span></td>
                <td className={`px-3 py-3 font-black ${row.creditsDelta >= 0 ? "text-emerald-300" : "text-amber-300"}`}>{row.creditsDelta >= 0 ? "+" : ""}{row.creditsDelta.toLocaleString()}</td>
                <td className="px-3 py-3 font-bold text-white">{row.balanceAfterCredits.toLocaleString()}</td>
                <td className="px-3 py-3 text-xs text-zinc-400">${(row.fundedCostMicroUsdDelta / 1_000_000).toFixed(4)}</td>
                <td className="max-w-52 truncate px-3 py-3 font-mono text-[11px] text-zinc-600">{row.reservationId || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 text-sm text-zinc-500">No credit ledger entries have been recorded.</div> : null}
      </div>
    </section>
  );
}
