import Link from "next/link";
import {
  AdminDataTable,
  type AdminDataColumn,
} from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import type { AdminMessageShape } from "@/lib/adminLocale";
import type { adminPlanChangesMessages } from "@/lib/adminMessages/planChanges";
import type { AdminTone } from "@/lib/adminUiCore";

type Messages = AdminMessageShape<(typeof adminPlanChangesMessages)["en"]>;

/** One `PlanChangeRequest` as this screen shows it: identifiers and dates, no email or amount. */
export type AdminPlanChangeRow = {
  id: string;
  userId: string;
  execution: string;
  fromTier: string;
  toTier: string;
  billingInterval: string;
  status: string;
  renewalDecision: string;
  appliesAt: string | null;
  confirmedAt: string | null;
  settledAt: string | null;
};

/** The page reads at most this many rows per list. */
export const ROW_LIMIT = 200;

const STATUS_TONE: Record<string, AdminTone> = {
  pending: "info",
  applied: "ok",
  cancelled: "idle",
  expired: "idle",
  failed: "bad",
};

const formatDate = (value: string | null, locale: string, fallback: string) =>
  value
    ? new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Australia/Brisbane",
        timeZoneName: "short",
      }).format(new Date(value))
    : fallback;

/**
 * Plans & pricing > Plan changes. Read-only: a scheduled downgrade is
 * cancelled by the customer (or by releasing the schedule in Stripe), and the
 * webhook settles every row, so nothing here writes.
 */
export function AdminPlanChangesPanel({
  pending,
  recent,
  messages: m,
  locale,
}: {
  /** Null when the read failed -- never drawn as an empty list. */
  pending: AdminPlanChangeRow[] | null;
  recent: AdminPlanChangeRow[] | null;
  messages: Messages;
  locale: string;
}) {
  const columns: AdminDataColumn<AdminPlanChangeRow>[] = [
    {
      key: "account",
      header: m.columns.account,
      render: (row) => (
        <Link
          href={`/admin/users/${encodeURIComponent(row.userId)}?tab=billing`}
          className="font-mono text-xs text-sky-300 hover:underline"
        >
          {row.userId}
        </Link>
      ),
    },
    {
      key: "change",
      header: m.columns.change,
      render: (row) => (
        <span className="flex flex-col">
          <span className="font-semibold">{`${row.fromTier} → ${row.toTier}`}</span>
          <span className="text-xs text-zinc-500">
            {m.execution[row.execution as keyof Messages["execution"]] ?? row.execution}
            {row.renewalDecision === "cancellation_cleared_by_explicit_consent"
              ? ` · ${m.renewalResumed}`
              : ""}
          </span>
        </span>
      ),
    },
    {
      key: "interval",
      header: m.columns.interval,
      render: (row) =>
        m.interval[row.billingInterval as keyof Messages["interval"]] ?? row.billingInterval,
    },
    {
      key: "status",
      header: m.columns.status,
      render: (row) => (
        <AdminStatusChip tone={STATUS_TONE[row.status] ?? "unknown"}>
          {m.status[row.status as keyof Messages["status"]] ?? row.status}
        </AdminStatusChip>
      ),
    },
    {
      key: "appliesAt",
      header: m.columns.appliesAt,
      render: (row) => formatDate(row.appliesAt, locale, m.notSet),
    },
    {
      key: "confirmedAt",
      header: m.columns.confirmedAt,
      render: (row) => formatDate(row.confirmedAt, locale, m.notSet),
      hideOnCard: true,
    },
    {
      key: "settledAt",
      header: m.columns.settledAt,
      render: (row) => formatDate(row.settledAt, locale, m.notSet),
    },
  ];

  const section = (
    title: string,
    rows: AdminPlanChangeRow[] | null,
    empty: string,
    detail?: string,
    testId?: string
  ) => (
    <section className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      <div>
        <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
        {detail ? <p className="mt-1 text-sm text-zinc-400">{detail}</p> : null}
      </div>
      {rows ? (
        <AdminDataTable
          footer={
            rows.length >= ROW_LIMIT ? (
              <p className="px-4 py-2 text-xs text-zinc-500">{m.truncated(ROW_LIMIT)}</p>
            ) : undefined
          }
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          caption={`${m.caption}: ${title}`}
          cardTitle={(row) => `${row.fromTier} → ${row.toTier}`}
          emptyState={<AdminStateBlock kind="empty" title={empty} />}
        />
      ) : (
        <AdminStateBlock kind="error" title={m.readFailedTitle} detail={m.readFailedDetail} />
      )}
    </section>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="admin-plan-changes">
      {section(m.pendingTitle, pending, m.emptyPending, m.pendingDetail, "admin-plan-changes-pending")}
      {section(m.recentTitle, recent, m.emptyRecent, undefined, "admin-plan-changes-recent")}
    </div>
  );
}
