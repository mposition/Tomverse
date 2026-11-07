"use client";

import Link from "next/link";
import { GitPullRequest } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminBars } from "@/components/admin/ui/AdminCharts";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminEngineeringAgentOverviewMessages } from "@/lib/adminMessages/engineeringAgentOverview";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import type { AgentOfficeEngineeringState } from "@/lib/agentOffice/live";
import type { EngineeringOverviewBody } from "@/lib/engineeringAgentOverviewRead";
import { classifyEngineeringPr, type EngineeringPrKind } from "@/lib/engineeringAgentOverviewCore";

const PR_RECORD_HREF = "/admin/engineering-agent?tab=runs&view=pull-requests";

const KIND_TONE: Record<EngineeringPrKind, AdminTone> = {
  ready: "info",
  waiting: "idle",
  merged: "ok",
  closed: "idle",
};

/**
 * The engineering agent's Overview: four numbers, the pull requests in
 * progress with the ones that only wait for a person on top, and how long
 * runs took to open one. Everything here is a reading; the merge, and every
 * decision, stays a person's on its own tab and route. A part that did not
 * read says so; it is never drawn as zero.
 */
export function AdminEngineeringOverview({
  head,
  body,
}: {
  head: AgentOfficeEngineeringState;
  body: EngineeringOverviewBody;
}) {
  const m = useAdminMessages(adminEngineeringAgentOverviewMessages);
  const observed = head.kind === "observed" ? head : null;
  const ready = body.pullRequests?.filter((row) => classifyEngineeringPr(row) === "ready").length ?? null;
  const pendingTotal = observed ? observed.pending.t2Draft + observed.pending.decision + observed.pending.stateMismatch : null;
  const since = observed?.activeSince ? formatAestDateTime(observed.activeSince) : null;
  const times = body.minutesToPr;

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="engineering-overview">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminKpiCard
          label={m.kpi.openPrs}
          value={body.openPrs}
          detail={ready === null ? undefined : m.kpi.openPrsDetail(ready)}
          tone={ready !== null && ready > 0 ? "warn" : "neutral"}
        />
        <AdminKpiCard
          label={m.kpi.activeRuns}
          value={observed ? observed.activeRuns : null}
          detail={observed ? (observed.activeRuns > 0 && since ? m.kpi.activeRunsDetail(since) : m.kpi.activeRunsNone) : undefined}
        />
        <AdminKpiCard
          label={m.kpi.decisions}
          value={pendingTotal}
          detail={
            observed
              ? m.kpi.decisionsDetail(observed.pending.t2Draft, observed.pending.decision, observed.pending.stateMismatch)
              : undefined
          }
          tone={pendingTotal !== null && pendingTotal > 0 ? "warn" : "neutral"}
        />
        <AdminKpiCard
          label={m.kpi.rejected}
          value={body.rejectedDrafts30d}
          detail={body.rejectedDrafts30d === null ? undefined : m.kpi.rejectedDetail}
        />
      </div>

      <AdminTile
        title={m.prs.title}
        description={m.prs.description}
        action={
          <Link href={PR_RECORD_HREF} className="text-sm font-bold text-blue-300 hover:underline">
            {m.prs.all}
          </Link>
        }
      >
        {body.pullRequests === null ? (
          <AdminStateBlock kind="error" title={m.readFailed} />
        ) : body.pullRequests.length === 0 ? (
          <AdminStateBlock kind="empty" title={m.prs.empty} />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="engineering-overview-prs">
            {body.pullRequests.map((row) => {
              const kind = classifyEngineeringPr(row);
              const highlighted = kind === "ready";
              const hint =
                kind === "ready" ? m.prs.readyHint : kind === "waiting" ? m.prs.waitingHint : kind === "merged" ? m.prs.mergedHint : m.prs.closedHint;
              return (
                <li
                  key={`${row.runId}-${row.prNumber}`}
                  data-kind={kind}
                  className={`flex min-w-0 flex-wrap items-center gap-3 rounded-xl border p-3 ${
                    highlighted ? "border-blue-500/40 bg-blue-500/10" : "border-zinc-800"
                  }`}
                >
                  <GitPullRequest className="h-5 w-5 shrink-0 text-zinc-400" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-zinc-100">
                      <span className="mr-1.5 font-normal text-zinc-500">#{row.prNumber}</span>
                      {hint}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {m.prs.run(row.runId)} · {m.prs.opened(formatAestDateTime(row.createdAt) ?? "-")}
                    </p>
                  </div>
                  <AdminStatusChip tone={KIND_TONE[kind]}>{m.prs.kind[kind]}</AdminStatusChip>
                  {highlighted ? (
                    <Link
                      href={PR_RECORD_HREF}
                      className="inline-flex min-h-9 items-center rounded-xl bg-blue-600 px-3 text-sm font-bold text-white hover:bg-blue-500"
                    >
                      {m.prs.check}
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </AdminTile>

      {times === null ? (
        <AdminTile title={m.times.title}>
          <AdminStateBlock kind="error" title={m.readFailed} />
        </AdminTile>
      ) : times.length > 0 ? (
        <AdminTile
          title={m.times.title}
          description={m.times.description(times.length)}
          action={<span className="text-sm font-bold text-zinc-300">{m.times.latest(times[times.length - 1])}</span>}
        >
          <AdminBars
            values={times}
            width={600}
            height={96}
            highlight={times.length - 1}
            label={m.times.title}
            className="w-full"
          />
        </AdminTile>
      ) : null}
    </div>
  );
}
