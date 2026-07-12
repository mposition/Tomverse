import { Activity, TimerReset } from "lucide-react";

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

const dateLabel = (value: string | null) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const statusClass = (status: string) => {
  if (status === "available") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (status === "limited") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  return "border-red-500/30 bg-red-500/10 text-red-200";
};

const widthClass = (value: number) => {
  if (value >= 90) return "w-full";
  if (value >= 75) return "w-3/4";
  if (value >= 50) return "w-1/2";
  if (value >= 25) return "w-1/4";
  if (value > 0) return "w-1/12";
  return "w-0";
};

export function AdminModelMetricsPanel({ rows }: { rows: AdminModelMetricRow[] }) {
  const sortedRows = [...rows].sort((a, b) => {
    if (b.failureCount5m !== a.failureCount5m) {
      return b.failureCount5m - a.failureCount5m;
    }
    return (b.latencyMs || 0) - (a.latencyMs || 0);
  });
  const maxFailures = Math.max(1, ...sortedRows.map((row) => row.failureCount5m));

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div>
        <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
          Model metrics
        </p>
        <h2 className="mt-2 text-2xl font-black text-white">
          Failure rate and latency watch
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          Model-level incident signals from the current monitoring window, combined
          with the latest manual provider health checks.
        </p>
      </div>

      <div className="mt-5 grid gap-3">
        {sortedRows.slice(0, 12).map((row) => (
          <article key={row.modelId} className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-black ${statusClass(row.status)}`}>
                    {row.status}
                  </span>
                  <h3 className="truncate font-black text-white">{row.modelName}</h3>
                  <span className="text-xs uppercase tracking-[0.14em] text-zinc-500">
                    {row.provider}
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  Last signal {dateLabel(row.updatedAt)} UTC / {row.recentErrorCode || "No recent error"}
                </p>
              </div>
              <div className="grid w-full gap-2 md:w-80">
                <div className="flex items-center justify-between text-xs text-zinc-500">
                  <span className="inline-flex items-center gap-1">
                    <Activity className="h-3.5 w-3.5" />
                    5m failures
                  </span>
                  <span className="font-black text-zinc-200">{row.failureCount5m}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={`h-full rounded-full bg-blue-500 ${widthClass(
                      (row.failureCount5m / maxFailures) * 100
                    )}`}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-zinc-500">
                  <span className="inline-flex items-center gap-1">
                    <TimerReset className="h-3.5 w-3.5" />
                    Last latency
                  </span>
                  <span className="font-black text-zinc-200">
                    {row.latencyMs === null ? "-" : `${row.latencyMs}ms`}
                  </span>
                </div>
              </div>
            </div>
          </article>
        ))}
        {sortedRows.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            No model metrics are available yet.
          </div>
        ) : null}
      </div>
    </section>
  );
}
