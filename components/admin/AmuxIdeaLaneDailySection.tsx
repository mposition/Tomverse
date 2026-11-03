"use client";

import Link from "next/link";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { aestStamp } from "@/lib/agentOffice/time";
import { adminQaReleaseTrainMessages } from "@/lib/adminMessages/qaReleaseTrain";
import type { AmuxIdeaLaneDailyReport, AmuxIdeaLaneDailyRow } from "@/lib/amux/ideaLaneDailyReportCore";

const PR_URL = "https://github.com/mposition/Tomverse/pull/";
const BOX = "flex min-w-0 flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3";

/** While the train tab streams the lane report in. */
export function AmuxIdeaLaneDailyLoading() {
  const m = useAdminMessages(adminQaReleaseTrainMessages);
  return (
    <p role="status" className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-400" data-testid="amux-idea-lane-daily-loading">
      {m.laneDailyLoading}
    </p>
  );
}

/**
 * The idea lane's daily report (lib/amux/ideaLaneDailyReportCore.ts): what
 * the lane merged into develop in the last 24 hours, each with its idea and
 * whether main has it yet. An empty day says "none"; an unread day says so.
 */
export function AmuxIdeaLaneDailySection({ report }: { report: AmuxIdeaLaneDailyReport }) {
  const m = useAdminMessages(adminQaReleaseTrainMessages);
  return (
    <section className={BOX} data-testid="amux-idea-lane-daily">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-sm font-semibold text-zinc-100">{m.laneDailyTitle}</h2>
        <p className="text-xs text-zinc-400">{m.laneDailyNote}</p>
        {report.status === "ok" ? (
          <p className="text-xs text-zinc-500">
            {m.laneDailyWindow
              .replace("{from}", aestStamp(report.windowStart))
              .replace("{to}", aestStamp(report.windowEnd))
              .replace("{at}", aestStamp(report.readAt))}
          </p>
        ) : null}
        {report.status === "ok" && report.stale ? <p className="text-xs text-amber-300">{m.laneDailyStale}</p> : null}
      </div>
      {report.status === "unread" ? (
        <p className="text-sm text-amber-300" data-testid="amux-idea-lane-daily-unread">
          {m.laneDailyUnread.replace("{failure}", report.failure)}
        </p>
      ) : report.rows.length === 0 ? (
        <p className="text-sm text-zinc-300" data-testid="amux-idea-lane-daily-none">
          {m.laneDailyNone}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col divide-y divide-zinc-800">
          {report.rows.map((row) => (
            <LaneRow key={row.number} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LaneRow({ row }: { row: AmuxIdeaLaneDailyRow }) {
  const m = useAdminMessages(adminQaReleaseTrainMessages);
  const main =
    row.main === "on_main"
      ? row.mainPullRequest !== null
        ? m.laneDailyOnMain.replace("{number}", String(row.mainPullRequest))
        : m.laneDailyOnMainUnnamed
      : row.main === "in_main_pull_request"
        ? m.laneDailyInMainPull.replace("{number}", String(row.mainPullRequest ?? ""))
        : m.laneDailyNotOnMain;
  const tone = row.main === "on_main" ? "text-emerald-300" : row.main === "in_main_pull_request" ? "text-blue-300" : "text-amber-300";
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2 text-sm" data-testid={`amux-idea-lane-daily-row-${row.number}`}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <a className="font-mono text-blue-300 hover:underline" href={`${PR_URL}${row.number}`} target="_blank" rel="noreferrer">
          #{row.number}
        </a>
        <span className="min-w-0 break-words text-zinc-100">{row.title}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        <span>{m.laneDailyMerged.replace("{at}", aestStamp(row.mergedAt))}</span>
        <span className={tone}>{main}</span>
        <Link className="text-blue-300 hover:underline" href={row.ideaHref}>
          {m.laneDailyIdea}
        </Link>
      </div>
    </li>
  );
}
