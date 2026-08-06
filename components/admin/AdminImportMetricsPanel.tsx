import { AlertTriangle } from "lucide-react";
import type { ExternalImportReport } from "@/lib/externalImportMetrics";

/**
 * External conversation import and memory metrics.
 *
 * `/api/admin/external-imports` has existed since Release A and nothing in the
 * console rendered it, so the report was reachable only by typing the URL. It
 * now has a home as the Analytics page's second section, where the rest of the
 * product's operational measurements already live.
 *
 * Content-free by construction (policy §22): every value below is a count, a
 * rate, a bucket or a version label. Titles, filenames, message content,
 * external IDs, digests and fingerprints are excluded at the query layer.
 */

const percent = (value: number | null) =>
  value === null ? "no data" : `${(value * 100).toFixed(1)}%`;

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
        {label}
      </p>
      <p className="mt-3 text-2xl font-black text-white">{value}</p>
      <p className="mt-1 text-xs leading-5 text-zinc-400">{detail}</p>
    </div>
  );
}

function BucketTable({
  caption,
  buckets,
}: {
  caption: string;
  buckets: Record<string, number>;
}) {
  const entries = Object.entries(buckets);
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <h3 className="text-sm font-black text-white">{caption}</h3>
      <dl className="mt-3 grid gap-1.5">
        {entries.map(([label, count]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="truncate text-xs text-zinc-400">{label}</dt>
            <dd className="text-sm font-bold tabular-nums text-zinc-100">{count}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function AdminImportMetricsPanel({
  report,
}: {
  report: ExternalImportReport;
}) {
  const { imports, counters } = report;

  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
        <h2 className="text-2xl font-black text-white">
          Conversation import and memory
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          Imports created in the last {report.windowDays} days, from{" "}
          {report.since.slice(0, 10)} UTC. Counts and rates only — no titles,
          filenames, content, external IDs, digests, or fingerprints are read by
          this report.
        </p>

        {imports.unavailable ? (
          <p className="mt-4 inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            The import tables are not migrated in this environment yet.
          </p>
        ) : null}
        {imports.truncated ? (
          <p className="mt-4 inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            The window contains more imports than this report samples. Treat the
            figures below as a sample of the window, not a total.
          </p>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Imports"
            value={String(imports.imports)}
            detail={`${imports.completed} completed · ${imports.failed} failed · ${imports.cancelled} cancelled · ${imports.active} active`}
          />
          <Metric
            label="Duplicate share"
            value={percent(imports.duplicateShare)}
            detail="Conversations skipped as exact duplicates, over all examined."
          />
          <Metric
            label="Truncation share"
            value={percent(imports.truncationShare)}
            detail="Finalized messages stored truncated."
          />
          <Metric
            label="Quota rejections"
            value={
              counters.unavailable ? "no data" : String(counters.quota_rejected)
            }
            detail={
              counters.unavailable
                ? "The counter table is not available in this environment."
                : `${counters.staging_expired} staging sweeps in the same window.`
            }
          />
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <BucketTable
          caption="Completed imports by conversation count"
          buckets={imports.conversationBuckets}
        />
        <BucketTable
          caption="Completed imports by stored bytes"
          buckets={imports.byteBuckets}
        />
        <BucketTable
          caption="Created → finalized latency"
          buckets={imports.finalizeLatencyBuckets}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-sm font-black text-white">By provider</h3>
          {imports.byProvider.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-400">
              No import was created in this window.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.14em] text-zinc-400">
                  <tr>
                    <th className="px-2 py-2">Provider</th>
                    <th className="px-2 py-2">Imports</th>
                    <th className="px-2 py-2">Completed</th>
                    <th className="px-2 py-2">Failed</th>
                    <th className="px-2 py-2">Conversations</th>
                    <th className="px-2 py-2">Duplicates</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-200">
                  {imports.byProvider.map((row) => (
                    <tr key={row.provider} className="border-t border-zinc-800">
                      <td className="px-2 py-2 font-bold">{row.provider}</td>
                      <td className="px-2 py-2 tabular-nums">{row.imports}</td>
                      <td className="px-2 py-2 tabular-nums">{row.completed}</td>
                      <td className="px-2 py-2 tabular-nums">{row.failed}</td>
                      <td className="px-2 py-2 tabular-nums">
                        {row.finalizedConversations}
                      </td>
                      <td className="px-2 py-2 tabular-nums">
                        {row.duplicatesSkipped}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h3 className="text-sm font-black text-white">
            Parser versions and failure codes
          </h3>
          <div className="mt-3 grid gap-1.5">
            {imports.byParserVersion.map((row) => (
              <div
                key={row.parserVersion}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="truncate font-mono text-xs text-zinc-300">
                  {row.parserVersion}
                </span>
                <span className="text-sm font-bold tabular-nums text-zinc-100">
                  {row.imports} · {row.failed} failed
                </span>
              </div>
            ))}
            {Object.entries(imports.failureCodes).map(([code, count]) => (
              <div key={code} className="flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-xs text-amber-200">
                  {code}
                </span>
                <span className="text-sm font-bold tabular-nums text-amber-100">
                  {count}
                </span>
              </div>
            ))}
            {imports.byParserVersion.length === 0 &&
            Object.keys(imports.failureCodes).length === 0 ? (
              <p className="text-sm text-zinc-400">
                No parser or failure data in this window.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
