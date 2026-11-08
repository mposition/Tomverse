"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminChannelIcon } from "@/components/admin/ui/AdminChannelIcon";
import { AdminDisclosureTable, type AdminDisclosureColumn } from "@/components/admin/ui/AdminDisclosureTable";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminMeter } from "@/components/admin/ui/AdminMeter";
import { AdminReadFailed } from "@/components/admin/ui/AdminReadFailed";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import {
  amuxUsageTotals, formatAmuxCount, formatAmuxPercent, formatAmuxUsd, groupAmuxUsageByWorker, type AmuxUsageWorker,
} from "@/lib/adminAmuxUsage";
import type { AmuxWorkerChannel } from "@/lib/adminAmuxFlow";
import { adminAmuxBoardViewsMessages } from "@/lib/adminMessages/amuxBoardViews";
import type { AmuxCliUsageSummaryRow } from "@/lib/amux/adminCliUsageSummary";

const microUsd = (value: string): string => {
  const amount = BigInt(value);
  return `${(amount / BigInt(1_000_000)).toString()}.${(amount % BigInt(1_000_000)).toString().padStart(6, "0")}`;
};

/**
 * Worker usage coverage on the Diagnostics tab: four headline numbers, then one
 * row per worker; a row opens to the models and rounds behind it. A call that
 * was not reported is never counted as zero, and an estimate covers only the
 * calls with a known price. A failed read is said, never drawn as zero usage.
 */
export function AmuxCliUsagePanel({ view, workerChannels }: { view: {
  rows: AmuxCliUsageSummaryRow[];
  recorded: number;
  unmeasuredLowerBound: number;
} | null; workerChannels?: Record<string, AmuxWorkerChannel> | null }) {
  const m = useAdminMessages(adminAmuxBoardViewsMessages).usage;
  if (view === null) {
    return <section data-testid="amux-cli-usage-panel" aria-label={m.title}>
      <AdminReadFailed title={m.unavailableTitle} detail={m.unavailableDetail} />
    </section>;
  }
  const workers = groupAmuxUsageByWorker(view.rows);
  const totals = amuxUsageTotals(workers);
  const costKnown = totals.pricedCalls > 0;
  const columns: AdminDisclosureColumn<AmuxUsageWorker>[] = [
    { key: "worker", header: m.columns.worker, render: (row) => {
      const channel = workerChannels?.[row.worker] ?? null;
      return <span className="inline-flex items-center gap-2 font-bold text-zinc-100">
        {channel && <AdminChannelIcon channel={channel} size={18} />}{row.worker}</span>;
    } },
    { key: "executor", header: m.columns.executor, render: (row) =>
      <span className="font-mono text-xs text-zinc-400">{row.executors.join(", ")}</span> },
    { key: "recorded", header: m.columns.recorded, render: (row) =>
      <span className="font-bold tabular-nums text-white">{formatAmuxCount(row.recorded)}</span> },
    { key: "unmeasured", header: m.columns.unmeasured, render: (row) =>
      <span className="font-bold tabular-nums text-white">{formatAmuxCount(row.unmeasured)}</span> },
    { key: "rate", header: m.columns.rate, render: (row) =>
      <span className="flex min-w-24 items-center gap-2">
        <AdminMeter fraction={row.rate} label={m.columns.rate + " " + row.worker} className="w-24" />
        <span className="font-bold tabular-nums text-white">{formatAmuxPercent(row.rate)}</span></span> },
    { key: "cost", header: m.columns.cost, render: (row) => row.pricedCalls === 0 ?
      <span className="font-bold text-zinc-300">{m.noPrice}</span> :
      <span className="font-bold text-white">{formatAmuxUsd(row.knownCostMicrousd)}
        {row.partialPricing && <span className="ml-1 text-xs font-normal text-zinc-500">{m.partial}</span>}</span> },
  ];
  const d = m.detail;
  return <section className="flex min-w-0 flex-col gap-4" data-testid="amux-cli-usage-panel" aria-label={m.title}>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <AdminKpiCard label={m.recorded} value={formatAmuxCount(totals.recorded)} detail={m.windowDays} />
      <AdminKpiCard label={m.unmeasured} value={m.unmeasuredValue(totals.unmeasured)}
        detail={m.unmeasuredDetail} tone={totals.unmeasured > 0 ? "warn" : "neutral"} />
      <AdminKpiCard label={m.rate} value={formatAmuxPercent(totals.rate)} detail={m.rateDetail}
        tone={totals.rate > 0 ? "warn" : "neutral"} />
      <AdminKpiCard label={m.cost} value={costKnown ? formatAmuxUsd(totals.knownCostMicrousd) : m.costUnknown}
        detail={m.costDetail} />
    </div>
    <p className="sr-only" data-testid="amux-cli-usage-total">
      {m.recorded} {totals.recorded} · {m.unmeasured} {m.unmeasuredValue(totals.unmeasured)}</p>
    <AdminTile title={m.tableTitle} description={m.lede}
      action={<span className="text-xs text-zinc-500">{m.windowDays}</span>}>
      <div className="-mx-5 -mb-5 overflow-hidden border-t border-zinc-800">
        <AdminDisclosureTable columns={columns} rows={workers} rowKey={(row) => row.worker} caption={m.tableCaption}
          expandLabel={(row) => m.expand(row.worker)} collapseLabel={(row) => m.collapse(row.worker)}
          emptyState={<AdminStateBlock kind="empty" title={m.empty} />}
          detail={(row) => <div className="flex flex-col gap-3">
            <div className="overflow-x-auto">
              <table className="w-full min-w-120 border-collapse text-xs">
                <thead><tr className="text-zinc-500">
                  {[d.model, d.round, d.recorded, d.unknownUsage, d.noReceipt, d.input, d.output].map((label) =>
                    <th key={label} scope="col" className="px-2 py-1.5 text-left font-medium">{label}</th>)}
                </tr></thead>
                <tbody>{row.rows.map((item) => <tr key={`${item.executor}:${item.source}:${item.model}:${item.round}`}
                  className="border-t border-zinc-800 text-zinc-200">
                  <td className="px-2 py-1.5 font-mono">{item.model}</td>
                  <td className="px-2 py-1.5 tabular-nums">{item.round ?? d.none}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatAmuxCount(item.recorded)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatAmuxCount(item.usageUnknown)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatAmuxCount(item.noReceiptAttempts)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatAmuxCount(item.reportedInputTokens)}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatAmuxCount(item.reportedOutputTokens)}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <AdminTechInfo summary={m.techSummary}>
              <ul className="flex flex-col gap-1">{row.rows.map((item) =>
                <li key={`${item.executor}:${item.source}:${item.model}:${item.round}`} className="break-all">
                  {item.executor} · {item.source} · {item.model} · {d.round} {item.round ?? d.none} ·
                  {" "}{d.cacheRead} {formatAmuxCount(item.reportedCacheReadTokens)} ·
                  {" "}{d.cacheWrite} {item.cacheWriteReports === 0 ? d.none : formatAmuxCount(item.reportedCacheWriteTokens)} ·
                  {" "}{d.estimate} {item.pricedCalls === 0 ? m.noPrice : "$" + microUsd(item.knownProjectedApiCostMicrousd) +
                    " (" + item.pricedCalls + "/" + item.recorded + ")"}
                </li>)}</ul>
            </AdminTechInfo>
          </div>} />
      </div>
    </AdminTile>
    <p className="text-xs text-zinc-500">{m.detailNote}</p>
  </section>;
}
