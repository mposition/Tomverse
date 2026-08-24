import Link from "next/link";

import type { AdminCampaignRow } from "@/lib/adminEmailCampaigns";

/**
 * The campaign list.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3.
 *
 * A server component with no client state: nothing here is an action. Every
 * decision a campaign needs is made on its own page, where the send gate, the
 * schedule check and the twelve conditions have been asked about *that*
 * campaign. Answering them per row would run three queries per campaign to
 * render a list an operator reads once and clicks through.
 *
 * The list is bounded and says so. A campaign list is not a log -- the campaign
 * an operator came here for is a recent one -- but a screen that shows the
 * newest hundred without saying "the newest hundred" is a screen whose emptiness
 * reads as "there are none".
 */

const STATUS_TONE: Record<string, string> = {
  draft: "border-zinc-700 bg-zinc-900 text-zinc-300",
  pending_approval: "border-amber-700 bg-amber-950/60 text-amber-200",
  approved: "border-blue-800 bg-blue-950/50 text-blue-200",
  running: "border-blue-800 bg-blue-950/50 text-blue-200",
  completed: "border-emerald-900 bg-emerald-950/40 text-emerald-200",
  cancelled: "border-zinc-700 bg-zinc-900 text-zinc-400",
  halted: "border-red-800 bg-red-950/50 text-red-200",
};

const when = (value: Date | null) =>
  value ? value.toISOString().replace("T", " ").slice(0, 16) : "—";

export function AdminEmailCampaignsPanel({
  rows,
  limit,
}: {
  rows: AdminCampaignRow[];
  limit: number;
}) {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        Email
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">Campaigns</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
        Every campaign this console knows about, newest first. A campaign is a
        set of waves over one piece of copy; approving it is where a person reads
        that copy, and it is the only two-person action here.
      </p>
      <p className="mt-2 max-w-3xl text-xs leading-5 text-zinc-500">
        Showing the newest {limit}. Drafting a campaign is done through{" "}
        <code className="rounded bg-zinc-900 px-1 py-0.5 text-zinc-300">
          POST /api/admin/email-campaigns
        </code>{" "}
        — the audience spec is a document the expansion layer owns, and a
        free-text box for it here would be a worse editor than the request that
        already validates it.
      </p>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
          No campaigns have been drafted.
        </p>
      ) : (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[62rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-500">
                <th scope="col" className="py-2 pr-4 font-bold">
                  Campaign
                </th>
                <th scope="col" className="py-2 pr-4 font-bold">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 font-bold">
                  Trigger
                </th>
                <th scope="col" className="py-2 pr-4 font-bold">
                  Languages
                </th>
                <th scope="col" className="py-2 pr-4 font-bold">
                  Waves
                </th>
                <th scope="col" className="py-2 pr-4 font-bold">
                  Next due
                </th>
                <th scope="col" className="py-2 font-bold">
                  Drafted
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-zinc-900 align-top last:border-b-0"
                  data-testid="admin-campaign-row"
                >
                  <td className="py-3 pr-4">
                    <Link
                      href={`/admin/email-campaigns/${row.id}`}
                      className="font-bold text-blue-300 underline-offset-4 hover:underline"
                    >
                      {row.templateKey}
                    </Link>
                    <p className="mt-1 text-xs text-zinc-500">{row.category}</p>
                    {row.claimsAutomaticTransition ? (
                      <p className="mt-1 text-xs font-bold text-amber-300">
                        Promises an automatic transition
                      </p>
                    ) : null}
                    {row.targetModelId ? (
                      <p className="mt-1 font-mono text-xs text-zinc-500">
                        {row.targetModelId}
                        {row.replacementModelId
                          ? ` → ${row.replacementModelId}`
                          : ""}
                      </p>
                    ) : null}
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-bold ${
                        STATUS_TONE[row.status] ??
                        "border-zinc-700 bg-zinc-900 text-zinc-300"
                      }`}
                    >
                      {row.status}
                    </span>
                    {row.approvedAt ? (
                      <p className="mt-1 text-xs text-zinc-500">
                        approved {when(row.approvedAt)}
                      </p>
                    ) : null}
                  </td>
                  <td className="py-3 pr-4 text-xs text-zinc-300">
                    {row.triggerMode}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-zinc-300">
                    {row.locales.join(", ") || "—"}
                  </td>
                  <td className="py-3 pr-4 text-xs text-zinc-300">
                    {row.waveCount}
                    {row.overdueWaves > 0 ? (
                      <span
                        className="ml-2 inline-flex rounded-full border border-red-800 bg-red-950/50 px-2 py-0.5 font-bold text-red-200"
                        data-testid="admin-campaign-overdue"
                      >
                        {row.overdueWaves} overdue
                      </span>
                    ) : null}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-zinc-300">
                    {when(row.nextWaveAt)}
                  </td>
                  <td className="py-3 text-xs text-zinc-400">
                    {when(row.createdAt)}
                    <p className="mt-1 truncate text-zinc-500">
                      {row.createdByEmail}
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
