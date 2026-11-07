"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { AdminRing } from "@/components/admin/ui/AdminCharts";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStackedArea } from "@/components/admin/ui/AdminStackedArea";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminProviderBoardMessages } from "@/lib/adminMessages/providerBoard";
import {
  RECONCILIATION_FLAG_PERCENT,
  COST_LAYER_COLORS,
  budgetSummary,
  formatMicroUsd,
  reconciliationRows,
  type CostSeries,
  type ReconciliationRow,
} from "@/lib/adminProviderBoardCore";
import { formatAestDate, formatAestDateTime, type AdminChartColor } from "@/lib/adminUiCore";
import type { ProviderHealthRow } from "@/lib/providerMonitoring";

export type CostBoardRow = Pick<
  ProviderHealthRow,
  | "provider"
  | "displayName"
  | "apiKeyConfigured"
  | "monthCostMicroUsd"
  | "providerReportedMonthCostMicroUsd"
  | "monthBudgetMicroUsd"
  | "projectedMonthEndMicroUsd"
  | "lastUsageSyncAt"
>;

function CostChart({
  series,
  names,
}: {
  series: CostSeries | null;
  names: Readonly<Record<string, string>>;
}) {
  const m = useAdminMessages(adminProviderBoardMessages).cost;
  const first = series?.days[0];
  const middle = series?.days[Math.floor((series?.days.length ?? 0) / 2)];
  const last = series?.days[(series?.days.length ?? 1) - 1];
  const drawable = series !== null && series.totalMicroUsd > 0 && series.layers.length > 0;
  return (
    <AdminTile
      title={m.chartTitle}
      description={m.chartDescription}
      action={
        drawable ? (
          <span className="text-sm font-bold text-zinc-200">{m.total(formatMicroUsd(series.totalMicroUsd))}</span>
        ) : undefined
      }
      data-testid="provider-cost-chart"
    >
      {series === null ? (
        <AdminStateBlock kind="error" title={m.chartUnread} />
      ) : !drawable ? (
        <AdminStateBlock kind="empty" title={m.empty} />
      ) : (
        <AdminStackedArea
          label={m.chartLabel}
          layers={series.layers.map((layer, index) => ({
            key: layer.key,
            label: layer.provider === null ? m.other : names[layer.provider] || layer.provider,
            color: COST_LAYER_COLORS[index] as AdminChartColor,
            values: layer.values,
          }))}
          edgeLabels={[
            formatAestDate(`${first}T00:00:00Z`) || "",
            formatAestDate(`${middle}T00:00:00Z`) || "",
            formatAestDate(`${last}T00:00:00Z`) || "",
          ]}
        />
      )}
    </AdminTile>
  );
}

function BudgetRing({ rows }: { rows: readonly CostBoardRow[] | null }) {
  const m = useAdminMessages(adminProviderBoardMessages).cost;
  const summary = rows === null ? null : budgetSummary(rows);
  const percent = summary ? Math.round(summary.fraction * 100) : 0;
  const color: AdminChartColor = !summary ? "blue" : summary.fraction >= 0.95 ? "red" : summary.fraction >= 0.8 ? "amber" : "blue";
  return (
    <AdminTile title={m.budgetTitle} data-testid="provider-budget-ring">
      {rows === null ? (
        <AdminStateBlock kind="error" title={m.budgetUnread} />
      ) : !summary ? (
        <AdminStateBlock kind="empty" title={m.budgetNone} />
      ) : (
        <div className="flex flex-col items-center gap-3 text-center">
          <AdminRing fraction={Math.min(1, summary.fraction)} size={140} stroke={14} color={color} label={m.budgetRingLabel(percent)}>
            <span className="flex flex-col">
              <span className="text-3xl font-bold tabular-nums text-white">{percent}%</span>
              <span className="text-xs text-zinc-500">{m.budgetUsed}</span>
            </span>
          </AdminRing>
          <p className="text-xl font-bold tabular-nums text-white">{formatMicroUsd(summary.usedMicroUsd)}</p>
          <p className="text-xs text-zinc-400">
            {m.budgetDetail(formatMicroUsd(summary.limitMicroUsd), formatMicroUsd(summary.projectedMicroUsd))}
          </p>
        </div>
      )}
    </AdminTile>
  );
}

function Reconciliation({ rows }: { rows: readonly CostBoardRow[] | null }) {
  const m = useAdminMessages(adminProviderBoardMessages).cost;
  const items = rows === null ? [] : reconciliationRows(rows);
  const synced = rows
    ?.map((row) => row.lastUsageSyncAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop();
  const columns: AdminDataColumn<ReconciliationRow>[] = [
    {
      key: "provider",
      header: m.provider,
      render: (row) => (
        <span className="flex items-center gap-2.5">
          <ModelLogo provider={row.provider} size="sm" />
          <span className="font-bold text-white">{row.displayName}</span>
        </span>
      ),
    },
    {
      key: "ours",
      header: m.ours,
      align: "right",
      render: (row) => <span className="tabular-nums">{formatMicroUsd(row.ourMicroUsd)}</span>,
    },
    {
      key: "invoice",
      header: m.invoice,
      align: "right",
      render: (row) => (
        <span className="tabular-nums">
          {row.reportedMicroUsd === null ? m.noInvoice : formatMicroUsd(row.reportedMicroUsd)}
        </span>
      ),
    },
    {
      key: "difference",
      header: m.difference,
      align: "right",
      render: (row) => (
        <span className={`tabular-nums ${row.state === "check" ? "font-bold text-amber-300" : ""}`}>
          {row.diffMicroUsd === null ? "-" : formatMicroUsd(row.diffMicroUsd)}
        </span>
      ),
    },
    {
      key: "status",
      header: m.status,
      render: (row) =>
        row.state === "match" ? (
          <AdminStatusChip tone="ok">{m.match}</AdminStatusChip>
        ) : row.state === "check" ? (
          <AdminStatusChip tone="warn">{m.check}</AdminStatusChip>
        ) : (
          <AdminStatusChip tone="unknown">{m.noInvoiceState}</AdminStatusChip>
        ),
    },
  ];
  return (
    <AdminTile
      title={m.reconTitle}
      description={`${m.reconDescription} ${m.flagNote(RECONCILIATION_FLAG_PERCENT)}`}
      action={
        rows === null ? undefined : (
          <span className="text-xs text-zinc-400">
            {synced ? m.lastSynced(formatAestDateTime(synced) || "") : m.neverSynced}
          </span>
        )
      }
      data-testid="provider-reconciliation"
    >
      {rows === null ? (
        <AdminStateBlock kind="error" title={m.reconUnread} />
      ) : (
        <AdminDataTable
          caption={m.reconCaption}
          columns={columns}
          rows={items}
          rowKey={(row) => row.provider}
          cardTitle={(row) => row.displayName}
          cardMeta={(row) =>
            row.reportedMicroUsd === null
              ? formatMicroUsd(row.ourMicroUsd)
              : `${formatMicroUsd(row.ourMicroUsd)} / ${formatMicroUsd(row.reportedMicroUsd)}`
          }
          cardAside={(row) =>
            row.state === "match" ? (
              <AdminStatusChip tone="ok">{m.match}</AdminStatusChip>
            ) : row.state === "check" ? (
              <AdminStatusChip tone="warn">{m.check}</AdminStatusChip>
            ) : (
              <AdminStatusChip tone="unknown">{m.noInvoiceState}</AdminStatusChip>
            )
          }
          emptyState={<AdminStateBlock kind="empty" title={m.reconEmpty} />}
        />
      )}
    </AdminTile>
  );
}

/**
 * The Usage & cost tab's three read-only tiles: the 30-day stacked cost, this
 * month's budget, and our record against each provider's invoice. A read that
 * failed arrives as `null` and says so, never as an empty chart or a zero.
 */
export function ProviderCostBoard({
  series,
  rows,
}: {
  series: CostSeries | null;
  rows: readonly CostBoardRow[] | null;
}) {
  const names = Object.fromEntries((rows ?? []).map((row) => [row.provider, row.displayName]));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <CostChart series={series} names={names} />
        <BudgetRing rows={rows} />
      </div>
      <Reconciliation rows={rows} />
    </div>
  );
}
