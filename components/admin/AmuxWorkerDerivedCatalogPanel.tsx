"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxWorkerDerivedCatalogMessages } from "@/lib/adminMessages/amuxWorkerDerivedCatalog";
import {
  amuxDerivedCatalogEntryIsConstant,
  type AmuxDerivedCatalogRow,
  type AmuxDerivedCatalogShadowView,
} from "@/lib/amux/workerDerivedCatalogCore";

type Messages = (typeof adminAmuxWorkerDerivedCatalogMessages)["en"];

const cellClass = "border-b border-zinc-200 px-2 py-2 align-top dark:border-zinc-700";
const headClass = `${cellClass} text-xs font-semibold text-zinc-600 dark:text-zinc-400`;

const verdictText = (m: Messages, row: AmuxDerivedCatalogRow) =>
  row.verdict === "differs"
    ? m.verdict.differs(row.differences.map((field) => m.field[field]).join(", "))
    : m.verdict[row.verdict];

/**
 * The derived catalog section of AMUX › Execution › Workers (version 35,
 * stage R2b), without hooks, so a test can call it and read the tree it
 * returns. Read-only: it offers nothing to click, and an unreadable side is
 * said as such rather than shown as a difference.
 */
export function AmuxWorkerDerivedCatalogView({ m, view }: { m: Messages; view: AmuxDerivedCatalogShadowView | null }) {
  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4" data-testid="amux-worker-derived-catalog-panel">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{m.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.description}</p>
      {view === null ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-worker-derived-catalog-unavailable">
          {m.unavailable}
        </p>
      ) : view.shadow === "off" ? (
        <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="amux-worker-derived-catalog-off">
          {m.shadowOff}
        </p>
      ) : view.comparison.status === "derived_unreadable" || view.comparison.status === "catalog_unreadable" ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-300" data-testid="amux-worker-derived-catalog-unreadable">
          {view.comparison.status === "derived_unreadable" ? m.derivedUnreadable : m.catalogUnreadable}
        </p>
      ) : (
        <>
          <p
            role="status"
            className={`text-sm font-semibold ${view.comparison.status === "equal" ? "text-zinc-900 dark:text-zinc-100" : "text-amber-700 dark:text-amber-300"}`}
            data-testid="amux-worker-derived-catalog-status"
          >
            {view.comparison.status === "equal"
              ? m.equal
              : m.different(view.comparison.rows.filter((row) => row.verdict !== "equal").length)}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm text-zinc-900 dark:text-zinc-100">
              <thead>
                <tr>
                  <th scope="col" className={headClass}>{m.column.worker}</th>
                  <th scope="col" className={headClass}>{m.column.env}</th>
                  <th scope="col" className={headClass}>{m.column.derived}</th>
                  <th scope="col" className={headClass}>{m.column.verdict}</th>
                </tr>
              </thead>
              <tbody>
                {view.comparison.rows.map((row) => (
                  <tr key={row.workerName} data-testid={`amux-worker-derived-catalog-row-${row.workerName}`}>
                    <th scope="row" className={`${cellClass} font-mono text-xs`}>
                      {row.workerName}
                      {amuxDerivedCatalogEntryIsConstant(row.workerName) ? (
                        <span className="block font-sans text-xs font-normal text-zinc-600 dark:text-zinc-400">{m.constant}</span>
                      ) : null}
                    </th>
                    <td className={cellClass}>{m.env[row.env]}</td>
                    <td className={cellClass}>{m.derived[row.derived]}</td>
                    <td className={cellClass} data-testid={`amux-worker-derived-catalog-verdict-${row.workerName}`}>
                      {verdictText(m, row)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{m.reload}</p>
        </>
      )}
    </section>
  );
}

export function AmuxWorkerDerivedCatalogPanel({ view }: { view: AmuxDerivedCatalogShadowView | null }) {
  const m = useAdminMessages(adminAmuxWorkerDerivedCatalogMessages) as Messages;
  return <AmuxWorkerDerivedCatalogView m={m} view={view} />;
}
