import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { AmuxProcessAuditControls } from "@/components/admin/AmuxProcessAuditControls";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAmuxProcessAuditMessages } from "@/lib/adminMessages/amuxProcessAudit";
import { formatAestDate, formatAestDateTime } from "@/lib/adminUiCore";
import { processAuditDue, processAuditNextRunAt } from "@/lib/amuxProcessAuditCore";
import type { ProcessAuditAdminView } from "@/lib/amuxProcessAuditStore";

const BASE = "/admin/amux-execution?tab=process-audit";

/** The console has no typography plugin, so each Markdown element gets its classes here. */
const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => <h2 className="text-lg font-semibold text-zinc-50">{children}</h2>,
  h2: ({ children }) => <h3 className="mt-2 text-base font-semibold text-zinc-100">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-1 text-sm font-semibold text-zinc-100">{children}</h4>,
  ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
  table: ({ children }) => <table className="w-full border-collapse text-left text-xs">{children}</table>,
  th: ({ children }) => <th className="border-b border-zinc-700 px-2 py-1 font-medium text-zinc-200">{children}</th>,
  td: ({ children }) => <td className="border-b border-zinc-800 px-2 py-1 align-top">{children}</td>,
  code: ({ children }) => <code className="rounded bg-zinc-800 px-1 text-[0.85em] text-zinc-100">{children}</code>,
  a: ({ children }) => <span className="underline decoration-dotted">{children}</span>,
};

/**
 * Execution board › Process analysis (owner only): the schedule controls, the
 * list of stored reports and one report -- its top items and changes as
 * structured rows, then the full Markdown. The Markdown is the model's text,
 * masked at the boundary; react-markdown renders no raw HTML.
 */
export async function AmuxProcessAuditPanel({ view }: { view: ProcessAuditAdminView | null }) {
  const m = await getAdminMessages(adminAmuxProcessAuditMessages);
  if (view === null) {
    return <AdminTile title={m.title} description={m.readFailed} data-testid="amux-process-audit-read-failed" />;
  }
  const now = new Date();
  const lastReportAt = view.reports[0]?.createdAt ?? null;
  const due = processAuditDue({ settings: view.settings, lastReportAt, now });
  const nextRunAt = processAuditNextRunAt(view.settings, lastReportAt, now);
  const status = [
    view.settings.enabled ? m.stateOn(view.settings.cadenceDays) : m.stateOff,
    nextRunAt ? m.nextRun(formatAestDateTime(nextRunAt) ?? "") : null,
    view.settings.runRequestedAt ? m.requested(formatAestDateTime(view.settings.runRequestedAt) ?? "") : null,
    !due.due && due.reason === "running" && view.settings.claim
      ? m.running(formatAestDateTime(view.settings.claim.at) ?? "") : null,
  ].filter((line): line is string => line !== null);
  const selected = view.selected;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="amux-process-audit">
      <AdminTile title={m.title} description={m.intro}>
        <AmuxProcessAuditControls enabled={view.settings.enabled} cadenceDays={view.settings.cadenceDays} status={status} />
        <p className="mt-3 text-xs text-zinc-500">{m.boxNote}</p>
      </AdminTile>
      <div className="grid min-w-0 gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <AdminTile title={m.listTitle} as="section">
          {view.reports.length === 0 ? <p className="text-sm text-zinc-400">{m.empty}</p> : (
            <ul className="flex flex-col gap-1" data-testid="amux-process-audit-list">
              {view.reports.map((report, index) => (
                <li key={report.id}>
                  <Link prefetch={false} href={`${BASE}&report=${encodeURIComponent(report.id)}`}
                    aria-current={selected?.id === report.id ? "page" : undefined}
                    className={`block rounded px-2 py-1.5 text-sm ${selected?.id === report.id ? "bg-zinc-800 text-zinc-50" : "text-zinc-300 hover:bg-zinc-900"}`}>
                    <span className="font-medium">{formatAestDate(report.createdAt)}</span>
                    {index === 0 ? <span className="ml-2 text-xs text-emerald-400">{m.latest}</span> : null}
                    <span className="block truncate text-xs text-zinc-500">{report.headline}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </AdminTile>
        {selected === null ? null : (
          <div className="flex min-w-0 flex-col gap-5">
            <AdminTile as="article" title={selected.headline || formatAestDateTime(selected.createdAt)}
              description={[
                m.windowLabel(formatAestDate(selected.windowStart) ?? "", formatAestDate(selected.windowEnd) ?? ""),
                m.commitLabel(selected.developSha.slice(0, 9)),
                selected.trigger === "run_now" ? m.triggerRunNow : m.triggerSchedule,
                selected.model,
              ].filter(Boolean).join(" · ")}>
              {selected.analysis && selected.analysis.topItems.length > 0 ? (
                <section aria-label={m.topTitle} className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold text-zinc-200">{m.topTitle}</h3>
                  <ol className="flex flex-col gap-2" data-testid="amux-process-audit-top">
                    {selected.analysis.topItems.map((item) => (
                      <li key={`${item.rank}-${item.title}`} className="rounded border border-zinc-800 px-3 py-2">
                        <div className="flex flex-wrap items-baseline gap-2 text-sm">
                          <span className="font-semibold text-zinc-100">{item.rank}. {item.title}</span>
                          <span className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-300">{m.status[item.status]}</span>
                          <span className="text-xs text-zinc-500">{item.stage}</span>
                        </div>
                        <p className="mt-1 text-sm text-zinc-300">{item.proposal}</p>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
              {selected.analysis ? (
                <section aria-label={m.changesTitle} className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                  {([
                    [m.newStopReasons, selected.analysis.changes.newStopReasons],
                    [m.resolved, selected.analysis.changes.resolved],
                    [m.notes, selected.analysis.changes.notes],
                  ] as const).map(([label, entries]) => (
                    <div key={label}>
                      <h4 className="font-medium text-zinc-200">{label}</h4>
                      {entries.length === 0 ? <p className="text-zinc-500">{m.none}</p> : (
                        <ul className="list-disc pl-4 text-zinc-300">{entries.map((entry) => <li key={entry}>{entry}</li>)}</ul>
                      )}
                    </div>
                  ))}
                </section>
              ) : null}
            </AdminTile>
            <AdminTile as="article" title={m.fullReport}>
              <div className="flex min-w-0 flex-col gap-3 overflow-x-auto text-sm leading-6 text-zinc-300" data-testid="amux-process-audit-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{selected.markdown}</ReactMarkdown>
              </div>
            </AdminTile>
          </div>
        )}
      </div>
    </div>
  );
}
