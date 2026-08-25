import Link from "next/link";

import {
  AdminRevealableAddress,
  AdminRevealAddressesButton,
} from "@/components/admin/AdminAddressReveal";

import type { AdminEmailDeliveryRow } from "@/lib/adminEmailDeliveries";
import {
  DELIVERY_STATUSES,
  UNDELIVERED_STATUSES,
  type DeliveryFilters,
} from "@/lib/adminEmailDeliveryFilters";

/**
 * The outbox, read back.
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
 */

const STATUS_TONE: Record<string, string> = {
  abandoned: "border-red-800 bg-red-950/50 text-red-200",
  failed: "border-red-800 bg-red-950/50 text-red-200",
  bounced: "border-amber-800 bg-amber-950/50 text-amber-200",
  complained: "border-amber-800 bg-amber-950/50 text-amber-200",
  suppressed: "border-zinc-700 bg-zinc-900 text-zinc-300",
  skipped: "border-zinc-700 bg-zinc-900 text-zinc-300",
  pending: "border-zinc-700 bg-zinc-900 text-zinc-300",
  sent: "border-emerald-900 bg-emerald-950/40 text-emerald-200",
  delivered: "border-emerald-900 bg-emerald-950/40 text-emerald-200",
};

const when = (value: Date | null) =>
  value ? value.toISOString().replace("T", " ").slice(0, 19) : "—";

const hrefFor = (statuses: readonly string[]) =>
  `/admin/email-delivery?tab=deliveries&status=${statuses.join(",")}`;

export function AdminEmailDeliveriesPanel({
  rows,
  filters,
  statusCounts,
  nextCursor,
  mayRevealAddresses,
}: {
  rows: AdminEmailDeliveryRow[];
  filters: DeliveryFilters;
  statusCounts: Record<string, number>;
  nextCursor: string | null;
  /** D10: `owner` and `ops`. Resolved on the server. */
  mayRevealAddresses: boolean;
}) {
  const showing = new Set(filters.statuses);
  const hidden = DELIVERY_STATUSES.filter((status) => !showing.has(status));
  const hiddenRows = hidden.reduce(
    (total, status) => total + (statusCounts[status] ?? 0),
    0
  );

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        Email
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">Deliveries</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
        Every message the outbox has handled, and what became of it. Abandoned
        rows are the dead-letter queue — they stay here with their attempt count
        and error rather than moving somewhere that loses both.
      </p>

      {/* D10: masked by default, revealed by a deliberate audited act. The
          sentence is on screen rather than in a comment -- an operator who sees
          dots and no explanation concludes the data is missing. */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <AdminRevealAddressesButton
          kind="delivery"
          rowIds={rows.map((row) => row.id)}
          allowed={mayRevealAddresses}
        />
      </div>

      <nav
        aria-label="Delivery status filters"
        className="mt-5 flex flex-wrap gap-2"
      >
        <Link
          href={hrefFor(UNDELIVERED_STATUSES)}
          data-testid="email-delivery-filter-undelivered"
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${
            hidden.length > 0
              ? "border-blue-700 bg-blue-950/50 text-blue-200"
              : "border-zinc-700 bg-zinc-900 text-zinc-300"
          }`}
        >
          Did not arrive
        </Link>
        {DELIVERY_STATUSES.map((status) => (
          <Link
            key={status}
            href={hrefFor([status])}
            data-testid={`email-delivery-filter-${status}`}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              showing.has(status) && showing.size === 1
                ? "border-blue-700 bg-blue-950/50 text-blue-200"
                : "border-zinc-700 bg-zinc-900 text-zinc-300"
            }`}
          >
            {status}
            <span className="ml-2 font-mono text-zinc-500">
              {statusCounts[status] ?? 0}
            </span>
          </Link>
        ))}
      </nav>

      {/* Said on screen, not implied by an empty table: a filtered view that
          does not name what it excludes reads as a total. */}
      <p
        data-testid="email-delivery-scope"
        className="mt-4 text-xs text-zinc-500"
      >
        Showing {rows.length} row{rows.length === 1 ? "" : "s"} in{" "}
        {filters.statuses.join(", ")}.
        {hidden.length > 0
          ? ` ${hiddenRows} row${hiddenRows === 1 ? "" : "s"} in other statuses are not shown.`
          : ""}
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[64rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="py-2 pr-4 font-semibold">Status</th>
              <th className="py-2 pr-4 font-semibold">Template</th>
              <th className="py-2 pr-4 font-semibold">Recipient</th>
              <th className="py-2 pr-4 font-semibold">Attempts</th>
              <th className="py-2 pr-4 font-semibold">Last error</th>
              <th className="py-2 pr-4 font-semibold">Created</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  data-testid="email-delivery-empty"
                  className="py-6 text-sm text-zinc-500"
                >
                  Nothing in these statuses.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr
                key={row.id}
                data-testid="email-delivery-row"
                className="border-t border-zinc-900 align-top"
              >
                <td className="py-3 pr-4">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                      STATUS_TONE[row.status] ??
                      "border-zinc-700 bg-zinc-900 text-zinc-300"
                    }`}
                  >
                    {row.status}
                  </span>
                  {row.skipReason ? (
                    <span className="mt-1 block font-mono text-[11px] text-zinc-500">
                      {row.skipReason}
                    </span>
                  ) : null}
                </td>
                <td className="py-3 pr-4">
                  <span className="font-mono text-xs text-zinc-200">
                    {row.templateVersion.template.key}
                  </span>
                  <span className="mt-1 block text-[11px] text-zinc-500">
                    {row.templateVersion.template.classification} · v
                    {row.templateVersion.version} · {row.lane}
                  </span>
                  {/* Written by us and identical for every recipient of this
                      version, which is what makes a row identifiable without
                      reading anybody's mail. */}
                  {row.renderedSubject ? (
                    <span className="mt-1 block max-w-md truncate text-[11px] text-zinc-400">
                      {row.renderedSubject}
                    </span>
                  ) : null}
                </td>
                <td className="py-3 pr-4">
                  <AdminRevealableAddress
                    rowId={row.id}
                    masked={row.emailAddressMasked}
                  />
                  <span className="mt-1 block text-[11px] text-zinc-500">
                    {row.jurisdictionCountry} · {row.language}
                  </span>
                </td>
                <td className="py-3 pr-4 font-mono text-xs">{row.attempts}</td>
                <td className="py-3 pr-4 font-mono text-xs text-zinc-400">
                  {row.lastErrorKind ?? "—"}
                </td>
                <td className="py-3 pr-4 font-mono text-[11px] text-zinc-500">
                  {when(row.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {nextCursor ? (
        <Link
          data-testid="email-delivery-next"
          href={`/admin/email-delivery?tab=deliveries&status=${filters.statuses.join(",")}&cursor=${nextCursor}`}
          className="mt-4 inline-block rounded-full border border-zinc-700 bg-zinc-900 px-4 py-1.5 text-xs font-semibold text-zinc-200"
        >
          Older
        </Link>
      ) : null}
    </section>
  );
}
