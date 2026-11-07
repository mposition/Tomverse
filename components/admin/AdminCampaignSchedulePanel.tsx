import Link from "next/link";

import type { EmailCampaignsMessages } from "@/components/admin/AdminEmailCampaignsPanel";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import type { AdminCampaignWaveRow } from "@/lib/adminEmailCampaigns";
import { adminMessagesFor } from "@/lib/adminLocale";
import { getAdminLocale } from "@/lib/adminLocaleServer";
import { adminEmailCampaignsMessages } from "@/lib/adminMessages/emailCampaigns";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";

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

const WAVE_STATUS_TONE: Record<string, AdminTone> = {
  pending: "idle",
  expanding: "info",
  expanded: "info",
  sending: "info",
  done: "ok",
  cancelled: "idle",
  halted: "bad",
};

const when = (value: Date | null) => formatAestDateTime(value) ?? "—";

export function AdminCampaignScheduleView({
  m: messages,
  rows,
  limit,
}: {
  m: EmailCampaignsMessages;
  /** `null` when the read failed: shown as an error, never as a clear schedule. */
  rows: AdminCampaignWaveRow[] | null;
  limit: number;
}) {
  const m = messages.schedule;
  if (rows === null) {
    return (
      <AdminTile title={m.title} description={m.intro}>
        <AdminStateBlock kind="error" title={m.loadFailed} />
      </AdminTile>
    );
  }
  const overdue = rows.filter((row) => row.overdue);
  const upcoming = rows.filter((row) => !row.overdue);

  const table = (list: AdminCampaignWaveRow[], testid: string) => {
    const columns: AdminDataColumn<AdminCampaignWaveRow>[] = [
      {
        key: "due",
        header: m.columns.due,
        render: (row) => (
          <span data-testid={testid} className="font-mono text-xs text-zinc-300">
            {when(row.scheduledAt)}
          </span>
        ),
      },
      {
        key: "campaign",
        header: m.columns.campaign,
        render: (row) => (
          <>
            <Link
              href={`/admin/email-campaigns/${row.campaignId}`}
              className="font-bold text-blue-300 underline-offset-4 hover:underline"
            >
              {row.campaignTemplateKey}
            </Link>
            <span className="mt-0.5 block text-xs text-zinc-500">
              {m.campaignStatus(row.campaignStatus)}
            </span>
          </>
        ),
      },
      {
        key: "wave",
        header: m.columns.wave,
        render: (row) => (
          <span className="text-xs text-zinc-300">
            {row.kind}
            {row.sequence > 1 ? ` #${row.sequence}` : ""}
            {row.dryRun ? (
              <span className="ml-2 inline-flex">
                <AdminStatusChip tone="idle">{m.dryRun}</AdminStatusChip>
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "status",
        header: m.columns.status,
        render: (row) => (
          <AdminStatusChip tone={row.overdue ? "bad" : (WAVE_STATUS_TONE[row.status] ?? "idle")}>
            {m.waveStatuses[row.status] ?? row.status}
          </AdminStatusChip>
        ),
      },
      {
        key: "trigger",
        header: m.columns.trigger,
        hideOnCard: true,
        render: (row) => (
          <span className="text-xs text-zinc-300">
            {messages.list.triggers[row.triggerMode] ?? row.triggerMode}
          </span>
        ),
      },
      {
        key: "expanded",
        header: m.columns.expanded,
        hideOnCard: true,
        render: (row) => (
          <span className="text-xs text-zinc-300">
            {row.expandedCount}
            {row.recipientCap === null ? "" : m.cap(row.recipientCap)}
          </span>
        ),
      },
    ];
    return (
      <AdminDataTable
        caption={m.title}
        columns={columns}
        rows={list}
        rowKey={(row) => row.id}
        cardTitle={(row) => (
          <Link
            href={`/admin/email-campaigns/${row.campaignId}`}
            className="text-blue-300 underline-offset-4 hover:underline"
          >
            {row.campaignTemplateKey}
          </Link>
        )}
        cardMeta={(row) => (
          <>
            {when(row.scheduledAt)} · {row.kind}
            {row.sequence > 1 ? ` #${row.sequence}` : ""}
          </>
        )}
        cardAside={(row) => (
          <AdminStatusChip tone={row.overdue ? "bad" : (WAVE_STATUS_TONE[row.status] ?? "idle")}>
            {m.waveStatuses[row.status] ?? row.status}
          </AdminStatusChip>
        )}
      />
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminTile title={m.title} description={`${m.intro} ${m.showingSoonest(limit)}`} />

      <section
        className={`flex min-w-0 flex-col gap-3 rounded-2xl p-5 ${
          overdue.length > 0 ? "border border-red-500/40 bg-zinc-900" : "border border-zinc-800 bg-zinc-900"
        }`}
      >
        <h3 className="text-sm font-bold text-white">
          {m.overdueHeading} <span className="text-zinc-500">({overdue.length})</span>
        </h3>
        {overdue.length === 0 ? (
          <div data-testid="admin-campaign-schedule-clear">
            <AdminStateBlock kind="empty" title={m.overdueClear} />
          </div>
        ) : (
          <>
            <p className="text-sm text-amber-200">{m.overdueExplanation}</p>
            {table(overdue, "admin-campaign-wave-overdue")}
            <AdminTechInfo summary={m.overdueTechSummary}>
              {m.overdueTechBefore}{" "}
              <code className="text-amber-200">CAMPAIGN_WAVE_REFUSED_AT_SCHEDULE</code>{" "}
              {m.overdueTechAfter}
            </AdminTechInfo>
          </>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-bold text-white">
          {m.upcomingHeading} <span className="text-zinc-500">({upcoming.length})</span>
        </h3>
        {upcoming.length === 0 ? (
          <AdminStateBlock kind="empty" title={m.upcomingEmpty} />
        ) : (
          table(upcoming, "admin-campaign-wave-upcoming")
        )}
      </section>
    </div>
  );
}

export async function AdminCampaignSchedulePanel(props: {
  rows: AdminCampaignWaveRow[] | null;
  limit: number;
}) {
  const m = adminMessagesFor(adminEmailCampaignsMessages, await getAdminLocale());
  return <AdminCampaignScheduleView m={m} {...props} />;
}
