import { ModelLogo } from "@/components/chat/ModelLogo";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminModelMetricsMessages } from "@/lib/adminMessages/modelMetrics";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";

export type AdminModelMetricRow = {
  modelId: string;
  modelName: string;
  provider: string;
  status: string;
  failureCount5m: number;
  recentErrorCode: string | null;
  updatedAt: string | null;
  latencyMs: number | null;
};

const TABLE_ROWS = 12;

const toneOf = (status: string): AdminTone =>
  status === "available" ? "ok" : status === "limited" ? "warn" : "bad";

export async function AdminModelMetricsPanel({ rows }: { rows: AdminModelMetricRow[] }) {
  const m = await getAdminMessages(adminModelMetricsMessages);
  const sortedRows = [...rows]
    .sort((a, b) => {
      if (b.failureCount5m !== a.failureCount5m) {
        return b.failureCount5m - a.failureCount5m;
      }
      return (b.latencyMs || 0) - (a.latencyMs || 0);
    })
    .slice(0, TABLE_ROWS);
  const word = (status: string) =>
    status === "available" ? m.stateAvailable : status === "limited" ? m.stateLimited : m.stateOutage;
  const signal = (row: AdminModelMetricRow) =>
    `${formatAestDateTime(row.updatedAt) || "-"} / ${row.recentErrorCode || m.noRecentError}`;

  const columns: AdminDataColumn<AdminModelMetricRow>[] = [
    {
      key: "model",
      header: m.model,
      render: (row) => (
        <span className="flex items-center gap-2.5">
          <ModelLogo provider={row.provider} size="md" />
          <span className="min-w-0">
            <span className="block truncate font-bold text-white">{row.modelName}</span>
            <span className="block truncate text-xs text-zinc-500">{row.provider}</span>
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: m.status,
      render: (row) => <AdminStatusChip tone={toneOf(row.status)}>{word(row.status)}</AdminStatusChip>,
    },
    {
      key: "failures",
      header: m.failures5m,
      align: "right",
      render: (row) => <span className="font-bold tabular-nums">{row.failureCount5m}</span>,
    },
    {
      key: "latency",
      header: m.lastLatency,
      align: "right",
      render: (row) => (
        <span className="tabular-nums">{row.latencyMs === null ? m.noLatency : `${row.latencyMs} ms`}</span>
      ),
    },
    {
      key: "signal",
      header: m.lastSignal,
      hideOnCard: true,
      render: (row) => <span className="text-xs text-zinc-400">{signal(row)}</span>,
    },
  ];

  return (
    <AdminTile title={m.title} description={m.description} data-testid="admin-model-metrics">
      <AdminDataTable
        caption={m.caption}
        columns={columns}
        rows={sortedRows}
        rowKey={(row) => row.modelId}
        cardTitle={(row) => row.modelName}
        cardMeta={signal}
        cardAside={(row) => (
          <AdminStatusChip tone={toneOf(row.status)}>{word(row.status)}</AdminStatusChip>
        )}
        emptyState={<AdminStateBlock kind="empty" title={m.empty} />}
      />
    </AdminTile>
  );
}
