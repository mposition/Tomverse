"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxCliUsageMessages } from "@/lib/adminMessages/amuxCliUsage";
import type { AmuxCliUsageSummaryRow } from "@/lib/amux/adminCliUsageSummary";

const tokens = (value: string): string => BigInt(value).toLocaleString();
const microUsd = (value: string): string => {
  const amount = BigInt(value);
  return `$${(amount / BigInt(1_000_000)).toString()}.${
    (amount % BigInt(1_000_000)).toString().padStart(6, "0")}`;
};

export function AmuxCliUsagePanel({ view }: { view: {
  rows: AmuxCliUsageSummaryRow[];
  recorded: number;
  unmeasuredLowerBound: number;
} | null }) {
  const m = useAdminMessages(adminAmuxCliUsageMessages);
  return <section className="mx-auto w-full max-w-6xl rounded-lg border border-zinc-200 p-4 dark:border-zinc-700"
    data-testid="amux-cli-usage-panel">
    <h2 className="text-lg font-semibold">{m.title}</h2>
    <p className="text-sm text-zinc-600 dark:text-zinc-300">{m.description}</p>
    {view === null ? <p role="status">{m.unavailable}</p> : <>
      <p className="mt-2 text-sm" data-testid="amux-cli-usage-total">
        {m.totals(view.recorded, view.unmeasuredLowerBound)}
      </p>
      {view.rows.length === 0 ? <p>{m.empty}</p> :
        <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr>{[m.worker, m.model, m.round, m.recorded, m.unknown,
            m.missing, m.rate, m.reportedInput, m.reportedOutput,
            m.cacheRead, m.cacheWrite, m.projected].map((label) =>
            <th key={label} scope="col" className="border-b p-2">{label}</th>)}</tr></thead>
          <tbody>{view.rows.map((row) => <tr key={`${row.worker}:${row.model}:${row.round}`}>
            <td className="border-b p-2">{row.worker}</td>
            <td className="border-b p-2">{row.model}</td>
            <td className="border-b p-2">{row.round ?? m.none}</td>
            <td className="border-b p-2">{row.recorded}</td>
            <td className="border-b p-2">{row.usageUnknown}</td>
            <td className="border-b p-2">{row.noReceiptAttempts}</td>
            <td className="border-b p-2">{(row.unmeasuredRateLowerBound * 100).toFixed(1)}%</td>
            <td className="border-b p-2">{tokens(row.reportedInputTokens)}</td>
            <td className="border-b p-2">{tokens(row.reportedOutputTokens)}</td>
            <td className="border-b p-2">{tokens(row.reportedCacheReadTokens)}</td>
            <td className="border-b p-2">{row.cacheWriteReports === 0 ? m.none :
              tokens(row.reportedCacheWriteTokens)}</td>
            <td className="border-b p-2">{row.pricedCalls === 0 ?
              m.projectedUnknown : <>{microUsd(row.knownProjectedApiCostMicrousd)}<br />
                <span className="text-xs text-zinc-500">{m.partialCoverage} ({row.pricedCalls}/{row.recorded})</span></>}</td>
          </tr>)}</tbody>
        </table></div>}
    </>}
  </section>;
}
