"use client";

import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { dmAdminRequestDetailHref } from "@/lib/amux/decisionMakerAdminHrefs";
import { dmReportInstant } from "@/components/admin/AmuxDecisionMakerReportPanel";
import { adminAmuxDecisionMakerRequestsMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import {
  DM_ADMIN_REQUEST_LIST_LIMIT,
  dmAdminDeliveryStatus,
  dmAdminRequestStatus,
  type DmAdminRequestList,
  type DmAdminRequestRow,
  type DmAdminRequestStatus,
} from "@/lib/amux/decisionMakerAdminCore";

type Messages = (typeof adminAmuxDecisionMakerRequestsMessages)["en"];

const cellClass = "border-b border-zinc-800 px-3 py-3 align-top";
const headClass = "border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500";

/** One colour per kind of outcome, so a column of statuses reads at a glance. */
const statusTone = (status: DmAdminRequestStatus) =>
  status === "confirm" || status === "edit_confirm" ? "border-emerald-800 bg-emerald-950/50 text-emerald-200"
    : status === "proposal" || status === "running" || status === "assigned" || status === "awaiting_assignment"
      ? "border-sky-800 bg-sky-950/50 text-sky-200"
      : status === "routed_to_operator" || status === "escalate" || status === "transmit_unknown" || status === "result_unknown"
        ? "border-amber-800 bg-amber-950/50 text-amber-200"
        : status === "validation_failure" || status === "timeout" || status === "unavailable" || status === "assignment_expired"
          ? "border-red-800 bg-red-950/50 text-red-200"
          : "border-zinc-700 bg-zinc-800 text-zinc-300";

/** A plain function, not a component, so the hook-free view's tree holds the cell's text. */
const statusCell = (m: Messages, row: DmAdminRequestRow, dbNowMs: number) => {
  const status = dmAdminRequestStatus(row, dbNowMs);
  return (
    <td className={cellClass} data-testid={`amux-dm-request-status-${row.requestId}`} data-status={status}>
      <div className="flex flex-col gap-1">
        {/* §6: an irreversible proposal is shown before anything else about it. */}
        {row.irreversible === true ? (
          <span
            className="w-fit rounded-full border border-red-800 bg-red-950/50 px-2 py-0.5 text-xs font-semibold text-red-200"
            data-testid={`amux-dm-request-irreversible-${row.requestId}`}
          >
            {m.irreversible}
          </span>
        ) : null}
        <span className={`w-fit rounded-full border px-2.5 py-0.5 text-xs font-semibold ${statusTone(status)}`}>{m.statuses[status]}</span>
        {/* §5: a request whose directories were not confirmed deleted, whatever its status. */}
        {row.cleanupUnknownAtMs !== null ? (
          <span
            className="w-fit rounded-full border border-amber-800 bg-amber-950/50 px-2 py-0.5 text-xs font-semibold text-amber-200"
            data-testid={`amux-dm-request-cleanup-unknown-${row.requestId}`}
          >
            {m.cleanupUnknown}
          </span>
        ) : null}
        {row.route === "operator" && row.refusalCodes.length > 0 ? (
          <span className="text-xs text-zinc-400">
            {m.keptBecause(row.refusalCodes.join(", "))}
          </span>
        ) : null}
      </div>
    </td>
  );
};

/**
 * AMUX › Operations settings › Decision Maker, the newest requests
 * (docs/policy/amux-decision-maker.md §2, §6, §12 S2), without hooks, so a
 * test can call it and read the tree it returns.
 *
 * `list` is what the page read, or `null` when the read failed: then the
 * panel says so and shows no request. Its only links open one request on the
 * same tab; it changes nothing, and it states how many rows it
 * shows and that they are not totals (docs/ui-contracts/admin-console-ia.md).
 */
export function AmuxDecisionMakerRequestsView({ m, list }: { m: Messages; list: DmAdminRequestList | null }) {
  const cleanupUnknownCount = list === null ? 0 : list.rows.filter((row) => row.cleanupUnknownAtMs !== null).length;
  return (
    <section
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-5"
      data-testid="amux-decision-maker-requests-panel"
    >
      <header className="flex flex-col gap-1.5">
        <h2 className="text-base font-bold text-zinc-100">{m.title}</h2>
        <p className="text-sm leading-6 text-zinc-400">{m.description}</p>
        <p className="text-xs leading-5 text-zinc-500">{m.noEffect}</p>
      </header>
      {list === null ? (
        <p role="alert" className="text-sm text-red-300" data-testid="amux-dm-requests-unavailable">
          {m.unavailable}
        </p>
      ) : (
        <>
          <p className="text-xs text-zinc-500" data-testid="amux-dm-requests-shown">
            {`${m.shown(list.rows.length, DM_ADMIN_REQUEST_LIST_LIMIT)} ${m.computedAt(dmReportInstant(list.dbNowMs))}`}
          </p>
          {cleanupUnknownCount > 0 ? (
            <p
              className="rounded-lg border border-amber-800 bg-amber-950/50 px-4 py-3 text-sm text-amber-200"
              data-testid="amux-dm-requests-cleanup-unknown-notice"
            >
              {m.cleanupUnknownNotice(cleanupUnknownCount)}
            </p>
          ) : null}
          {list.rows.length === 0 ? (
            <p className="text-sm text-zinc-300" data-testid="amux-dm-requests-empty">
              {m.empty}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm text-zinc-100">
                <thead>
                  <tr>
                    {[m.createdAt, m.card, m.asker, m.route, m.status, m.delivery].map((heading) => (
                      <th key={heading} scope="col" className={headClass}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((row) => (
                    <tr key={row.requestId} className="hover:bg-zinc-800/40" data-testid={`amux-dm-request-${row.requestId}`}>
                      <td className={`${cellClass} whitespace-nowrap text-zinc-400`}>{dmReportInstant(row.createdAtMs)}</td>
                      <td className={cellClass}>
                        <Link
                          href={dmAdminRequestDetailHref(row.requestId)}
                          className="inline-flex min-h-11 items-center font-mono text-sm text-blue-300 underline"
                          data-testid={`amux-dm-request-open-${row.requestId}`}
                        >
                          {row.cardId}
                        </Link>
                        <span className="block text-xs text-zinc-400">
                          {m.revision(row.questionRevision)}
                        </span>
                      </td>
                      <td className={cellClass}>
                        <span className="font-mono text-xs">{row.askingWorkerId}</span>
                        <span className="block text-xs text-zinc-400">{row.askingProvider}</span>
                      </td>
                      <td className={cellClass}>
                        {row.route === "operator" ? m.operator : <span className="font-mono text-xs">{row.instance}</span>}
                      </td>
                      {statusCell(m, row, list.dbNowMs)}
                      <td
                        className={cellClass}
                        data-testid={`amux-dm-request-delivery-${row.requestId}`}
                        data-delivery={dmAdminDeliveryStatus(row)}
                      >
                        {m.deliveries[dmAdminDeliveryStatus(row)]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function AmuxDecisionMakerRequestsPanel({ list }: { list: DmAdminRequestList | null }) {
  const m = useAdminMessages(adminAmuxDecisionMakerRequestsMessages) as Messages;
  return <AmuxDecisionMakerRequestsView m={m} list={list} />;
}
