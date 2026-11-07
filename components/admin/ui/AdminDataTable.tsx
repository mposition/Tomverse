/**
 * The console's table. On a phone (below `sm`) the same rows render as cards,
 * so no table needs a horizontal scroll: a column that does not fit belongs on
 * the detail page instead.
 *
 * `cardTitle` / `cardMeta` / `cardAside` choose what a row's card shows; when
 * omitted the card lists every column as label and value.
 */
export type AdminDataColumn<Row> = {
  key: string;
  header: React.ReactNode;
  render: (row: Row) => React.ReactNode;
  align?: "left" | "right";
  /** Kept out of the phone card (it is still in the table). */
  hideOnCard?: boolean;
};

export function AdminDataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  cardTitle,
  cardMeta,
  cardAside,
  toolbar,
  footer,
  emptyState,
}: {
  columns: readonly AdminDataColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Read by screen readers; the visible title belongs to the surrounding tile. */
  caption: string;
  cardTitle?: (row: Row) => React.ReactNode;
  cardMeta?: (row: Row) => React.ReactNode;
  cardAside?: (row: Row) => React.ReactNode;
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  /** Shown instead of the table when `rows` is empty (an AdminStateBlock). */
  emptyState?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
      {toolbar ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">{toolbar}</div>
      ) : null}
      {rows.length === 0 && emptyState ? (
        <div className="p-4">{emptyState}</div>
      ) : (
        <>
          <table className="hidden w-full border-collapse text-sm sm:table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={`px-4 py-2.5 text-xs font-medium text-zinc-500 ${
                      column.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)} className="border-t border-zinc-800 hover:bg-zinc-950/40">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`px-4 py-3 align-middle text-zinc-200 ${
                        column.align === "right" ? "text-right" : "text-left"
                      }`}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="flex flex-col gap-2 p-3 sm:hidden" aria-label={caption}>
            {rows.map((row) => (
              <li
                key={rowKey(row)}
                className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3"
              >
                {cardTitle ? (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-bold text-zinc-100">{cardTitle(row)}</div>
                      {cardMeta ? <div className="mt-0.5 text-xs text-zinc-500">{cardMeta(row)}</div> : null}
                    </div>
                    {cardAside ? <div className="shrink-0">{cardAside(row)}</div> : null}
                  </>
                ) : (
                  <dl className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    {columns
                      .filter((column) => !column.hideOnCard)
                      .map((column) => (
                        <div key={column.key} className="contents">
                          <dt className="text-zinc-500">{column.header}</dt>
                          <dd className="min-w-0 text-zinc-200">{column.render(row)}</dd>
                        </div>
                      ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {footer ? <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3">{footer}</div> : null}
    </div>
  );
}
