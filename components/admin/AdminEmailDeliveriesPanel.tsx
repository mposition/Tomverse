import Link from "next/link";

import {
  AdminRevealableAddress,
  AdminRevealAddressesButton,
} from "@/components/admin/AdminAddressReveal";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminFilterChips } from "@/components/admin/ui/AdminFilterChips";
import { AdminKpiCard } from "@/components/admin/ui/AdminKpiCard";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import type { AdminEmailDeliveryRow } from "@/lib/adminEmailDeliveries";
import {
  DELIVERY_CLASSIFICATIONS,
  DELIVERY_STATUSES,
  UNDELIVERED_STATUSES,
  type DeliveryFilters,
} from "@/lib/adminEmailDeliveryFilters";
import { adminMessagesFor, type AdminMessageShape } from "@/lib/adminLocale";
import { getAdminLocale } from "@/lib/adminLocaleServer";
import { adminEmailDeliveryMessages } from "@/lib/adminMessages/emailDelivery";
import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";

/**
 * The outbox, read back, as the customer mail screen.
 *
 * Contract: docs/policy/email-notifications.md §9.5, §13.7.
 *
 * A server component with no client state. Filters are links, so a view is a
 * URL: the question an operator asks here is usually asked again by somebody
 * else, and a filter held in component state cannot be pasted into a ticket.
 *
 * The default view is the four statuses that mean nobody received the message
 * and nobody will, and it says so above the table. A history screen that opens
 * on everything opens on whatever was sent in the last minute, which is never
 * the question.
 *
 * No row is actionable. Nothing about a delivery is an administrator's to
 * change: a message that should not have been abandoned is enqueued again,
 * which writes a new row with its own idempotency key rather than reviving one
 * whose key the provider may still be suppressing.
 *
 * The numbers above the table are all-time counts by status, the only count the
 * loader gives. A figure the loader cannot give (a seven-day window, unsubscribe
 * totals) is left out rather than invented.
 */

export type EmailDeliveryMessages = AdminMessageShape<
  (typeof adminEmailDeliveryMessages)["en"]
>;

const STATUS_TONE: Record<string, AdminTone> = {
  abandoned: "bad",
  failed: "bad",
  bounced: "warn",
  complained: "warn",
  pending: "info",
  sent: "ok",
  delivered: "ok",
  suppressed: "idle",
  skipped: "idle",
};

const when = (value: Date | null) => formatAestDateTime(value, { seconds: true }) ?? "—";

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && right.every((entry) => left.includes(entry));

const classificationQuery = (kinds: readonly string[]) =>
  kinds.length > 0 ? `&classification=${kinds.join(",")}` : "";

/** A view of the log as a URL. Filters the chip does not change are kept. */
const deliveryHref = (
  filters: DeliveryFilters,
  patch: { statuses?: readonly string[]; classifications?: readonly string[] }
) =>
  `/admin/email-delivery?tab=deliveries&status=${(patch.statuses ?? filters.statuses).join(",")}${classificationQuery(
    patch.classifications ?? filters.classifications
  )}`;

export function AdminEmailDeliveriesView({
  m: messages,
  rows,
  filters,
  statusCounts,
  nextCursor,
  mayRevealAddresses,
}: {
  m: EmailDeliveryMessages;
  /** `null` when the read failed: shown as an error, never as an empty log. */
  rows: AdminEmailDeliveryRow[] | null;
  filters: DeliveryFilters;
  /** `null` when the counts could not be read. */
  statusCounts: Record<string, number> | null;
  nextCursor: string | null;
  /** D10: `owner` and `ops`. Resolved on the server. */
  mayRevealAddresses: boolean;
}) {
  const m = messages.deliveries;
  const showing = new Set<string>(filters.statuses);
  const hidden = DELIVERY_STATUSES.filter((status) => !showing.has(status));
  const count = (status: string) => statusCounts?.[status] ?? 0;
  const hiddenRows = hidden.reduce((total, status) => total + count(status), 0);

  const handedOff = count("sent") + count("delivered") + count("bounced") + count("complained");
  const unreadCounts = statusCounts === null;

  const columns: AdminDataColumn<AdminEmailDeliveryRow>[] = [
    {
      key: "recipient",
      header: m.columns.recipient,
      render: (row) => (
        <span data-testid="email-delivery-row" className="block">
          <AdminRevealableAddress rowId={row.id} masked={row.emailAddressMasked} />
          <span className="mt-0.5 block text-xs text-zinc-500">
            {row.jurisdictionCountry} · {row.language}
          </span>
        </span>
      ),
    },
    {
      key: "kind",
      header: m.columns.template,
      render: (row) => (
        <>
          <span className="block text-sm text-zinc-100">
            {m.kinds[row.templateVersion.classification] ?? row.templateVersion.classification}
          </span>
          <span className="mt-0.5 block font-mono text-xs text-zinc-500">
            {row.templateVersion.template.key} · v{row.templateVersion.version}
            {row.lane !== "standard" ? ` · ${row.lane}` : ""}
          </span>
        </>
      ),
    },
    {
      key: "subject",
      header: m.columns.subject,
      // Written by us and identical for every recipient of this version, which
      // is what makes a row identifiable without reading anybody's mail.
      render: (row) => (
        <span className="block max-w-xs truncate text-zinc-200">
          {row.renderedSubject || m.noSubject}
        </span>
      ),
    },
    {
      key: "created",
      header: m.columns.created,
      render: (row) => <span className="font-mono text-xs text-zinc-400">{when(row.createdAt)}</span>,
    },
    {
      key: "status",
      header: m.columns.status,
      render: (row) => (
        <>
          <AdminStatusChip tone={STATUS_TONE[row.status] ?? "idle"}>
            {m.statuses[row.status] ?? row.status}
          </AdminStatusChip>
          {row.skipReason ? (
            <span className="mt-1 block font-mono text-xs text-zinc-500">{row.skipReason}</span>
          ) : null}
          {row.deferReason && row.nextAttemptAt ? (
            // A pending row that is on schedule, not stuck: the backlog alert
            // leaves these out, so the list has to say why.
            <span className="mt-1 block font-mono text-xs text-zinc-500">
              {row.deferReason} → {when(row.nextAttemptAt)}
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: "attempts",
      header: m.columns.attempts,
      hideOnCard: true,
      render: (row) => <span className="font-mono text-xs">{row.attempts}</span>,
    },
    {
      key: "lastError",
      header: m.columns.lastError,
      hideOnCard: true,
      render: (row) => (
        <span className="font-mono text-xs text-zinc-400">{row.lastErrorKind ?? "—"}</span>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="email-delivery-kpis">
        <AdminKpiCard
          label={m.kpi.sent.label}
          value={unreadCounts ? null : handedOff.toLocaleString("en-US")}
          detail={m.kpi.sent.detail}
        />
        <AdminKpiCard
          label={m.kpi.delivered.label}
          value={
            unreadCounts || handedOff === 0
              ? null
              : `${((count("delivered") / handedOff) * 100).toFixed(1)}%`
          }
          detail={m.kpi.delivered.detail(count("delivered"), handedOff)}
        />
        <AdminKpiCard
          label={m.kpi.bounced.label}
          value={unreadCounts ? null : count("bounced").toLocaleString("en-US")}
          detail={m.kpi.bounced.detail(count("complained"))}
          tone={count("bounced") + count("complained") > 0 ? "warn" : "neutral"}
        />
        <AdminKpiCard
          label={m.kpi.held.label}
          value={unreadCounts ? null : count("suppressed").toLocaleString("en-US")}
          detail={m.kpi.held.detail}
        />
      </div>

      <AdminTile
        title={m.title}
        description={m.intro}
        action={
          rows ? (
            // D10: masked by default, revealed by a deliberate audited act. The
            // sentence is on screen rather than in a comment -- an operator who
            // sees dots and no explanation concludes the data is missing.
            <AdminRevealAddressesButton
              kind="delivery"
              rowIds={rows.map((row) => row.id)}
              allowed={mayRevealAddresses}
            />
          ) : null
        }
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-14 shrink-0 text-xs font-medium text-zinc-500">{m.kindGroup}</span>
            <AdminFilterChips
              label={m.kindFiltersLabel}
              chips={[
                {
                  key: "all",
                  label: m.allKinds,
                  href: deliveryHref(filters, { classifications: [] }),
                  active: filters.classifications.length === 0,
                  testId: "email-delivery-kind-all",
                },
                ...DELIVERY_CLASSIFICATIONS.map((kind) => ({
                  key: kind,
                  label: m.kinds[kind] ?? kind,
                  href: deliveryHref(filters, { classifications: [kind] }),
                  active: filters.classifications.length === 1 && filters.classifications[0] === kind,
                  testId: `email-delivery-kind-${kind}`,
                })),
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-14 shrink-0 text-xs font-medium text-zinc-500">{m.statusGroup}</span>
            <AdminFilterChips
              label={m.filtersLabel}
              chips={[
                {
                  key: "undelivered",
                  label: m.didNotArrive,
                  href: deliveryHref(filters, { statuses: UNDELIVERED_STATUSES }),
                  active: sameSet(filters.statuses, UNDELIVERED_STATUSES),
                  testId: "email-delivery-filter-undelivered",
                },
                ...DELIVERY_STATUSES.map((status) => ({
                  key: status,
                  label: m.statuses[status] ?? status,
                  href: deliveryHref(filters, { statuses: [status] }),
                  active: showing.size === 1 && showing.has(status),
                  count: statusCounts ? count(status) : undefined,
                  testId: `email-delivery-filter-${status}`,
                })),
              ]}
            />
          </div>
        </div>
        {/* Said on screen, not implied by an empty table: a filtered view that
            does not name what it excludes reads as a total. */}
        {rows ? (
          <p data-testid="email-delivery-scope" className="text-xs text-zinc-500">
            {m.scope(rows.length, filters.statuses.join(", "))}
            {hidden.length > 0 && statusCounts ? m.hiddenRows(hiddenRows) : ""}
          </p>
        ) : null}
      </AdminTile>

      {rows === null ? (
        <AdminStateBlock kind="error" title={m.loadFailed} />
      ) : (
        <AdminDataTable
          caption={m.title}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          cardTitle={(row) => (
            <AdminRevealableAddress rowId={row.id} masked={row.emailAddressMasked} />
          )}
          cardMeta={(row) => (
            <>
              {row.renderedSubject || m.noSubject} · {when(row.createdAt)}
            </>
          )}
          cardAside={(row) => (
            <AdminStatusChip tone={STATUS_TONE[row.status] ?? "idle"}>
              {m.statuses[row.status] ?? row.status}
            </AdminStatusChip>
          )}
          emptyState={
            <div data-testid="email-delivery-empty">
              <AdminStateBlock kind="empty" title={m.empty} />
            </div>
          }
          footer={
            nextCursor ? (
              <Link
                data-testid="email-delivery-next"
                href={`${deliveryHref(filters, {})}&cursor=${nextCursor}`}
                className="inline-flex min-h-8 items-center rounded-full border border-zinc-700 bg-zinc-900 px-4 text-xs font-bold text-zinc-200 hover:bg-zinc-800"
              >
                {m.older}
              </Link>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

export async function AdminEmailDeliveriesPanel(
  props: Omit<Parameters<typeof AdminEmailDeliveriesView>[0], "m">
) {
  const m = adminMessagesFor(adminEmailDeliveryMessages, await getAdminLocale());
  return <AdminEmailDeliveriesView m={m} {...props} />;
}
