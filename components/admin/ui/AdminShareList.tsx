import { adminChartColor, type AdminChartColor } from "@/lib/adminUiCore";

/**
 * Rows of "label, a bar, a value": a share of a whole, or an amount against
 * the largest row. The bar is relative to `max` (the largest value when
 * omitted), so a row's length is comparable with its neighbours'.
 */
export function AdminShareList({
  rows,
  color = "blue",
  max,
  className = "",
}: {
  rows: ReadonlyArray<{
    key: string;
    label: React.ReactNode;
    /** What is drawn at the left of the label, for example a logo. */
    lead?: React.ReactNode;
    value: number;
    /** The text at the right. */
    valueLabel: React.ReactNode;
    color?: AdminChartColor;
  }>;
  color?: AdminChartColor;
  max?: number;
  className?: string;
}) {
  const top = max ?? Math.max(0, ...rows.map((row) => row.value));
  return (
    <ul className={`flex flex-col gap-3 ${className}`}>
      {rows.map((row) => (
        <li key={row.key} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
          <span className="flex min-w-0 items-center gap-2 text-zinc-200">
            {row.lead}
            <span className="truncate">{row.label}</span>
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
            <span
              className="block h-full rounded-full"
              style={{
                width: `${top > 0 ? Math.max(row.value > 0 ? 2 : 0, (row.value / top) * 100) : 0}%`,
                backgroundColor: adminChartColor(row.color ?? color),
              }}
            />
          </span>
          <span className="text-right font-bold tabular-nums text-zinc-100">{row.valueLabel}</span>
        </li>
      ))}
    </ul>
  );
}
