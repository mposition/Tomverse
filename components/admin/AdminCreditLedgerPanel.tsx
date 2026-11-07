import { AdminCreditLedgerTable } from "@/components/admin/AdminCreditLedgerTable";
import { AdminSignedBars } from "@/components/admin/ui/AdminSignedBars";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminIntlLocale, adminMessagesFor } from "@/lib/adminLocale";
import { getAdminLocale } from "@/lib/adminLocaleServer";
import { adminCreditLedgerMessages } from "@/lib/adminMessages/creditLedger";
import {
  ledgerDailyFlow,
  ledgerTotals,
  type AdminCreditLedgerRow,
} from "@/lib/adminCreditLedgerStats";

export type { AdminCreditLedgerRow };

/**
 * The credit ledger: four figures, the daily flow and the entries.
 *
 * Read-only. Everything except the owed-credits card is worked out from the
 * rows the page read (the newest few), and the screen says so; none of it is a
 * period total. A failed read is an error, never an empty ledger.
 */
export async function AdminCreditLedgerPanel({
  rows,
  rowLimit,
  owed,
}: {
  /** `null` when the read failed. */
  rows: AdminCreditLedgerRow[] | null;
  /** How many rows the server read, so "newest N" is not read as a total. */
  rowLimit?: number;
  /** Credits customers owe, across all accounts; `null`/absent when it was not read. */
  owed?: { credits: number; customers: number } | null;
}) {
  const locale = await getAdminLocale();
  const m = adminMessagesFor(adminCreditLedgerMessages, locale);
  const intlLocale = adminIntlLocale(locale);
  const number = (value: number) => value.toLocaleString(intlLocale);

  if (rows === null) {
    return <AdminStateBlock kind="error" title={m.readFailed.title} detail={m.readFailed.detail} />;
  }

  const totals = ledgerTotals(rows);
  const flow = ledgerDailyFlow(rows);
  const typeLabels = m.types as Record<string, string>;
  const grantBreakdown = totals.grantedByType
    .slice(0, 3)
    .map((entry) => `${typeLabels[entry.type] ?? entry.type} ${number(entry.credits)}`)
    .join(", ");

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <AdminKpiCard
            label={m.cards.granted}
            value={totals.granted === 0 ? number(0) : `+${number(totals.granted)}`}
            detail={totals.granted > 0 ? grantBreakdown : m.cards.grantedNone}
          />
          <AdminKpiCard
            label={m.cards.used}
            value={totals.used === 0 ? number(0) : `-${number(totals.used)}`}
            detail={m.cards.usedDetail}
          />
          <AdminKpiCard
            label={m.cards.expired}
            value={totals.expired === 0 ? number(0) : `-${number(totals.expired)}`}
            detail={m.cards.expiredDetail}
          />
          <AdminKpiCard
            label={m.cards.owed}
            value={owed ? number(owed.credits) : null}
            detail={owed ? m.cards.owedDetail(owed.customers) : undefined}
            tone={owed && owed.credits > 0 ? "warn" : "neutral"}
          />
        </div>
        <p className="text-xs text-zinc-500">{m.cards.basis(rows.length)}</p>
      </div>

      {flow ? (
        <AdminTile
          title={m.flow.title}
          description={m.flow.description}
          action={
            <span className="flex items-center gap-3 text-xs text-zinc-400">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />
                {m.flow.granted}
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-2.5 w-2.5 rounded-sm bg-violet-500" />
                {m.flow.used}
              </span>
            </span>
          }
        >
          <AdminSignedBars up={flow.granted} down={flow.used} label={m.flow.chartLabel(flow.days.length)} />
          <div className="flex justify-between text-xs text-zinc-500">
            <span>{flow.days[0]}</span>
            <span>{flow.days[flow.days.length - 1]}</span>
          </div>
          {rowLimit && rows.length >= rowLimit ? <p className="text-xs text-zinc-500">{m.flow.partial}</p> : null}
        </AdminTile>
      ) : null}

      <section className="flex min-w-0 flex-col gap-3">
        <div>
          <h2 className="text-base font-bold text-white">{m.table.title}</h2>
          <p className="mt-0.5 text-sm text-zinc-400">
            {m.table.description}
            {rowLimit ? m.table.newestOnly(rowLimit) : ""}
            {m.table.openCustomer}
          </p>
        </div>
        <AdminCreditLedgerTable rows={rows} />
      </section>
    </div>
  );
}
