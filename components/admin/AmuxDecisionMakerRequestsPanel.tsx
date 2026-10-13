"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { dmReportInstant } from "@/components/admin/AmuxDecisionMakerReportPanel";
import { adminAmuxDecisionMakerRequestsMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import {
  DM_ADMIN_REQUEST_LIST_LIMIT,
  dmAdminDeliveryStatus,
  dmAdminRequestStatus,
  type DmAdminRequestList,
  type DmAdminRequestRow,
} from "@/lib/amux/decisionMakerAdminCore";

type Messages = (typeof adminAmuxDecisionMakerRequestsMessages)["en"];

const cellClass = "border-b border-zinc-200 px-2 py-2 align-top dark:border-zinc-700";

/** A plain function, not a component, so the hook-free view's tree holds the cell's text. */
const statusCell = (m: Messages, row: DmAdminRequestRow, dbNowMs: number) => {
  const status = dmAdminRequestStatus(row, dbNowMs);
  return (
    <td className={cellClass} data-testid={`amux-dm-request-status-${row.requestId}`} data-status={status}>
      <div className="flex flex-col gap-1">
        {/* §6: an irreversible proposal is shown before anything else about it. */}
        {row.irreversible === true ? (
          <span
            className="w-fit rounded border border-red-300 px-1.5 py-0.5 text-xs font-semibold text-red-800 dark:border-red-700 dark:text-red-200"
            data-testid={`amux-dm-request-irreversible-${row.requestId}`}
          >
            {m.irreversible}
          </span>
        ) : null}
        <span>{m.statuses[status]}</span>
        {row.route === "operator" && row.refusalCodes.length > 0 ? (
          <span className="text-xs text-zinc-600 dark:text-zinc-400">
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
 * panel says so and shows no request. It offers no control -- a proposal is
 * opened, confirmed or rejected elsewhere -- and it states how many rows it
 * shows and that they are not totals (docs/ui-contracts/admin-console-ia.md).
 */
export function AmuxDecisionMakerRequestsView({ m, list }: { m: Messages; list: DmAdminRequestList | null }) {
  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4"
      data-testid="amux-decision-maker-requests-panel"
    >
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{m.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.description}</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.noEffect}</p>
      {list === null ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-dm-requests-unavailable">
          {m.unavailable}
        </p>
      ) : (
        <>
          <p className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="amux-dm-requests-shown">
            {`${m.shown(list.rows.length, DM_ADMIN_REQUEST_LIST_LIMIT)} ${m.computedAt(dmReportInstant(list.dbNowMs))}`}
          </p>
          {list.rows.length === 0 ? (
            <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-dm-requests-empty">
              {m.empty}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm text-zinc-900 dark:text-zinc-100">
                <thead>
                  <tr>
                    {[m.createdAt, m.card, m.asker, m.route, m.status, m.delivery].map((heading) => (
                      <th key={heading} scope="col" className={`${cellClass} font-medium`}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((row) => (
                    <tr key={row.requestId} data-testid={`amux-dm-request-${row.requestId}`}>
                      <td className={cellClass}>{dmReportInstant(row.createdAtMs)}</td>
                      <td className={cellClass}>
                        <span className="font-mono text-xs">{row.cardId}</span>
                        <span className="block text-xs text-zinc-600 dark:text-zinc-400">
                          {m.revision(row.questionRevision)}
                        </span>
                      </td>
                      <td className={cellClass}>
                        <span className="font-mono text-xs">{row.askingWorkerId}</span>
                        <span className="block text-xs text-zinc-600 dark:text-zinc-400">{row.askingProvider}</span>
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
