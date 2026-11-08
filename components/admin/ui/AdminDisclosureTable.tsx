"use client";

import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";

/**
 * A table whose rows open to show their own detail underneath, for a list that
 * reads as a summary per row and has a longer breakdown behind each one (for
 * example a worker, and its models and rounds).
 *
 * Closed by default. The toggle is a real button with `aria-expanded`, so it is
 * reachable by keyboard and named for screen readers. On a phone (below `sm`)
 * each row is a card with its columns as label and value, and the detail
 * opens inside it, so nothing needs a horizontal scroll.
 */
export type AdminDisclosureColumn<Row> = {
  key: string;
  header: React.ReactNode;
  render: (row: Row) => React.ReactNode;
  align?: "left" | "right";
};

export function AdminDisclosureTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  detail,
  expandLabel,
  collapseLabel,
  emptyState,
}: {
  columns: readonly AdminDisclosureColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Read by screen readers; the visible title belongs to the surrounding tile. */
  caption: string;
  /** What opens under a row. */
  detail: (row: Row) => React.ReactNode;
  expandLabel: (row: Row) => string;
  collapseLabel: (row: Row) => string;
  emptyState?: React.ReactNode;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  if (rows.length === 0 && emptyState) return <div className="p-4">{emptyState}</div>;
  const button = (row: Row) => {
    const key = rowKey(row);
    const expanded = open.has(key);
    return (
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? collapseLabel(row) : expandLabel(row)}
        onClick={() => toggle(key)}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400"
      >
        <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden />
      </button>
    );
  };
  return (
    <>
      <table className="hidden w-full border-collapse text-sm sm:table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="w-12 px-4 py-2.5">
              <span className="sr-only">{caption}</span>
            </th>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-4 py-2.5 text-xs font-medium text-zinc-500 ${column.align === "right" ? "text-right" : "text-left"}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <Fragment key={key}>
                <tr className="border-t border-zinc-800 hover:bg-zinc-950/40">
                  <td className="px-4 py-3 align-middle">{button(row)}</td>
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`px-4 py-3 align-middle text-zinc-200 ${column.align === "right" ? "text-right" : "text-left"}`}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {open.has(key) ? (
                  <tr className="bg-zinc-950/40">
                    <td />
                    <td colSpan={columns.length} className="px-4 pb-4 pt-1">
                      {detail(row)}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <ul className="flex flex-col gap-2 p-3 sm:hidden" aria-label={caption}>
        {rows.map((row) => {
          const key = rowKey(row);
          return (
            <li key={key} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="flex items-start gap-2">
                <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {columns.map((column) => (
                    <div key={column.key} className="contents">
                      <dt className="text-zinc-500">{column.header}</dt>
                      <dd className="min-w-0 text-zinc-200">{column.render(row)}</dd>
                    </div>
                  ))}
                </dl>
                {button(row)}
              </div>
              {open.has(key) ? (
                <div className="mt-3 border-t border-zinc-800 pt-3">
                  {detail(row)}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
