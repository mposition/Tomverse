import Link from "next/link";

import type { AdminCampaignWaveRow } from "@/lib/adminEmailCampaigns";

/**
 * Waves by the time they are due.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2.
 *
 * The section exists for one row shape the campaign list cannot show: a wave
 * that came due under `approved_schedule` and is still `pending`. The scheduler
 * reached it, one of the two gates refused it, and the wave row records neither
 * the attempt nor the reason — a refusal raises a
 * `CAMPAIGN_WAVE_REFUSED_AT_SCHEDULE` operational incident, which goes to
 * Sentry and the alert channels rather than to any table this console reads,
 * and it leaves the wave row exactly as it was. So "due and still pending" is
 * the only trace inside the console, and without this list the first person to
 * notice an approved send did not happen is somebody who never received it.
 *
 * Overdue rows are hoisted above the rest rather than merely coloured. A screen
 * that puts the failure in time order buries it under whatever is scheduled for
 * next month.
 */

const WAVE_STATUS_TONE: Record<string, string> = {
  pending: "border-zinc-700 bg-zinc-900 text-zinc-300",
  expanding: "border-blue-800 bg-blue-950/50 text-blue-200",
  expanded: "border-blue-800 bg-blue-950/50 text-blue-200",
  sending: "border-blue-800 bg-blue-950/50 text-blue-200",
  done: "border-emerald-900 bg-emerald-950/40 text-emerald-200",
  cancelled: "border-zinc-700 bg-zinc-900 text-zinc-400",
  halted: "border-red-800 bg-red-950/50 text-red-200",
};

const when = (value: Date | null) =>
  value ? value.toISOString().replace("T", " ").slice(0, 16) : "—";

export function AdminCampaignSchedulePanel({
  rows,
  limit,
}: {
  rows: AdminCampaignWaveRow[];
  limit: number;
}) {
  const overdue = rows.filter((row) => row.overdue);
  const upcoming = rows.filter((row) => !row.overdue);

  const table = (list: AdminCampaignWaveRow[], testid: string) => (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-500">
            <th scope="col" className="py-2 pr-4 font-bold">
              Due
            </th>
            <th scope="col" className="py-2 pr-4 font-bold">
              Campaign
            </th>
            <th scope="col" className="py-2 pr-4 font-bold">
              Wave
            </th>
            <th scope="col" className="py-2 pr-4 font-bold">
              Status
            </th>
            <th scope="col" className="py-2 pr-4 font-bold">
              Trigger
            </th>
            <th scope="col" className="py-2 font-bold">
              Expanded
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <tr
              key={row.id}
              className="border-b border-zinc-900 align-top last:border-b-0"
              data-testid={testid}
            >
              <td className="py-3 pr-4 font-mono text-xs text-zinc-300">
                {when(row.scheduledAt)}
              </td>
              <td className="py-3 pr-4">
                <Link
                  href={`/admin/email-campaigns/${row.campaignId}`}
                  className="font-bold text-blue-300 underline-offset-4 hover:underline"
                >
                  {row.campaignTemplateKey}
                </Link>
                <p className="mt-1 text-xs text-zinc-500">
                  campaign {row.campaignStatus}
                </p>
              </td>
              <td className="py-3 pr-4 text-xs text-zinc-300">
                {row.kind}
                {row.sequence > 1 ? ` #${row.sequence}` : ""}
                {row.dryRun ? (
                  <span className="ml-2 inline-flex rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 font-bold text-zinc-300">
                    dry run
                  </span>
                ) : null}
              </td>
              <td className="py-3 pr-4">
                <span
                  className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-bold ${
                    WAVE_STATUS_TONE[row.status] ??
                    "border-zinc-700 bg-zinc-900 text-zinc-300"
                  }`}
                >
                  {row.status}
                </span>
              </td>
              <td className="py-3 pr-4 text-xs text-zinc-300">
                {row.triggerMode}
              </td>
              <td className="py-3 text-xs text-zinc-300">
                {row.expandedCount}
                {row.recipientCap === null ? "" : ` / cap ${row.recipientCap}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        Email
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">Wave schedule</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
        Waves that have a time, across every campaign. Waves an operator starts
        by hand have no time and are not listed here — they are not late and
        never will be.
      </p>
      <p className="mt-2 max-w-3xl text-xs leading-5 text-zinc-500">
        Showing the {limit} soonest.
      </p>

      <div className="mt-5">
        <h3 className="text-sm font-black text-white">
          Due and not sent{" "}
          <span className="text-zinc-500">({overdue.length})</span>
        </h3>
        {overdue.length === 0 ? (
          <p
            className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400"
            data-testid="admin-campaign-schedule-clear"
          >
            Nothing is past its scheduled time.
          </p>
        ) : (
          <>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-200">
              The scheduler reached these and did not send them. Why is not
              stored on the wave: it is raised as a{" "}
              <code className="text-amber-100">
                CAMPAIGN_WAVE_REFUSED_AT_SCHEDULE
              </code>{" "}
              incident, which goes to Sentry and the operational alert channels
              and not to any page in this console. Open the campaign to see what
              its send gate refuses now.
            </p>
            {table(overdue, "admin-campaign-wave-overdue")}
          </>
        )}
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-black text-white">
          Upcoming <span className="text-zinc-500">({upcoming.length})</span>
        </h3>
        {upcoming.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
            Nothing is scheduled.
          </p>
        ) : (
          table(upcoming, "admin-campaign-wave-upcoming")
        )}
      </div>
    </section>
  );
}
