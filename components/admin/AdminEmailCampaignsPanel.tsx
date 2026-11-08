import Link from "next/link";
import { Mail, Plus } from "lucide-react";

import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import type { AdminCampaignRow } from "@/lib/adminEmailCampaigns";
import { adminMessagesFor, type AdminMessageShape } from "@/lib/adminLocale";
import { getAdminLocale } from "@/lib/adminLocaleServer";
import { adminEmailCampaignsMessages } from "@/lib/adminMessages/emailCampaigns";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";

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
 *
 * Open and click rates are not columns: nothing the list loads records them,
 * and a rate drawn without a count behind it would be invented. The recipient
 * count is the campaign's own estimate, and "not counted yet" when it has none.
 */

export type EmailCampaignsMessages = AdminMessageShape<
  (typeof adminEmailCampaignsMessages)["en"]
>;

const STATUS_TONE: Record<string, AdminTone> = {
  draft: "idle",
  pending_approval: "warn",
  approved: "info",
  running: "info",
  completed: "ok",
  cancelled: "idle",
  halted: "bad",
};

const when = (value: Date | null) => formatAestDateTime(value) ?? "—";

export function AdminEmailCampaignsView({
  m: messages,
  rows,
  limit,
}: {
  m: EmailCampaignsMessages;
  /** `null` when the read failed: shown as an error, never as an empty list. */
  rows: AdminCampaignRow[] | null;
  limit: number;
}) {
  const m = messages.list;

  const statusChip = (row: AdminCampaignRow) => (
    <AdminStatusChip tone={STATUS_TONE[row.status] ?? "idle"}>
      {m.statuses[row.status] ?? row.status}
    </AdminStatusChip>
  );

  const columns: AdminDataColumn<AdminCampaignRow>[] = [
    {
      key: "campaign",
      header: m.columns.campaign,
      render: (row) => (
        <span data-testid="admin-campaign-row" className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-blue-300">
            <Mail className="h-4 w-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <Link
              href={`/admin/email-campaigns/${row.id}`}
              className="font-bold text-blue-300 underline-offset-4 hover:underline"
            >
              {row.templateKey}
            </Link>
            <span className="mt-0.5 block text-xs text-zinc-500">{row.category}</span>
            {row.claimsAutomaticTransition ? (
              <span className="mt-0.5 block text-xs font-bold text-amber-300">
                {m.promisesTransition}
              </span>
            ) : null}
            {row.targetModelId ? (
              <span className="mt-0.5 block font-mono text-xs text-zinc-500">
                {row.targetModelId}
                {row.replacementModelId ? ` → ${row.replacementModelId}` : ""}
              </span>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      key: "recipients",
      header: m.columns.recipients,
      render: (row) =>
        row.estimatedRecipients === null ? (
          <span className="text-xs text-zinc-500">{m.recipientsUnknown}</span>
        ) : (
          <span className="font-bold tabular-nums">{m.recipientsCount(row.estimatedRecipients)}</span>
        ),
    },
    {
      key: "status",
      header: m.columns.status,
      render: (row) => (
        <>
          {statusChip(row)}
          {row.approvedAt ? (
            <span className="mt-1 block text-xs text-zinc-500">
              {m.approvedAt(when(row.approvedAt))}
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: "trigger",
      header: m.columns.trigger,
      render: (row) => (
        <span className="text-xs text-zinc-300">{m.triggers[row.triggerMode] ?? row.triggerMode}</span>
      ),
    },
    {
      key: "languages",
      header: m.columns.languages,
      render: (row) => (
        <span className="font-mono text-xs text-zinc-300">{row.locales.join(", ") || "—"}</span>
      ),
    },
    {
      key: "waves",
      header: m.columns.waves,
      render: (row) => (
        <span className="text-xs text-zinc-300">
          {row.waveCount}
          {row.overdueWaves > 0 ? (
            <span data-testid="admin-campaign-overdue" className="ml-2 inline-flex">
              <AdminStatusChip tone="bad">{m.overdue(row.overdueWaves)}</AdminStatusChip>
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "nextDue",
      header: m.columns.nextDue,
      hideOnCard: true,
      render: (row) => <span className="font-mono text-xs text-zinc-300">{when(row.nextWaveAt)}</span>,
    },
    {
      key: "drafted",
      header: m.columns.drafted,
      hideOnCard: true,
      render: (row) => (
        <span className="text-xs text-zinc-400">
          {when(row.createdAt)}
          <span className="mt-0.5 block max-w-[12rem] truncate text-zinc-500">{row.createdByEmail}</span>
        </span>
      ),
    },
  ];

  return (
    <AdminTile
      title={m.title}
      description={
        <>
          {m.intro} {m.draftingBefore(limit)}
        </>
      }
      action={
        <Link
          href="/admin/email-campaigns?tab=new"
          data-testid="admin-campaign-new"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {m.newCampaign}
        </Link>
      }
    >
      {rows === null ? (
        <AdminStateBlock kind="error" title={m.loadFailed} />
      ) : (
      <AdminDataTable
        caption={m.title}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        cardTitle={(row) => (
          <Link
            href={`/admin/email-campaigns/${row.id}`}
            className="text-blue-300 underline-offset-4 hover:underline"
          >
            {row.templateKey}
          </Link>
        )}
        cardMeta={(row) => (
          <>
            {row.estimatedRecipients === null
              ? m.recipientsUnknown
              : m.recipientsCount(row.estimatedRecipients)}
            {row.overdueWaves > 0 ? ` · ${m.overdue(row.overdueWaves)}` : ""}
          </>
        )}
        cardAside={statusChip}
        emptyState={<AdminStateBlock kind="empty" title={m.empty} />}
      />
      )}
    </AdminTile>
  );
}

export async function AdminEmailCampaignsPanel(props: {
  rows: AdminCampaignRow[] | null;
  limit: number;
}) {
  const m = adminMessagesFor(adminEmailCampaignsMessages, await getAdminLocale());
  return <AdminEmailCampaignsView m={m} {...props} />;
}
