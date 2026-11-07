/**
 * A weekday-by-hour grid: darker is busier. Cells are drawn from the blue
 * palette family at an opacity, so Light remaps them with the rest, and each
 * cell carries its own text for screen readers and hover.
 *
 * `matrix[row][column]`; rows are the weekdays in the order of `rowLabels`.
 * Renders nothing when every cell is zero (the caller says there was no
 * activity instead of drawing an empty grid).
 */
export function AdminHeatmap({
  matrix,
  rowLabels,
  columnLabelEvery = 6,
  cellLabel,
  label,
  className = "",
}: {
  matrix: readonly (readonly number[])[];
  rowLabels: readonly string[];
  /** Print a column caption every this many columns (0, 6, 12, 18 for hours). */
  columnLabelEvery?: number;
  cellLabel: (row: number, column: number, value: number) => string;
  label: string;
  className?: string;
}) {
  const max = Math.max(0, ...matrix.flat());
  if (max === 0 || matrix.length === 0) return null;
  const columns = matrix[0].length;
  return (
    <div className={`min-w-0 ${className}`}>
      <div role="table" aria-label={label} className="flex flex-col gap-1">
        {matrix.map((row, rowIndex) => (
          <div role="row" key={rowIndex} className="flex items-center gap-2">
            <span role="rowheader" className="w-6 shrink-0 text-xs text-zinc-500">
              {rowLabels[rowIndex]}
            </span>
            <div className="grid min-w-0 flex-1 gap-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {row.map((value, column) => {
                const text = cellLabel(rowIndex, column, value);
                return (
                  <span
                    role="cell"
                    key={column}
                    title={text}
                    aria-label={text}
                    className="aspect-square min-w-0 rounded-[5px]"
                    style={{
                      backgroundColor: value > 0 ? "var(--color-blue-500)" : "var(--color-zinc-800)",
                      opacity: value > 0 ? 0.12 + 0.88 * (value / max) : 0.5,
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2 text-xs text-zinc-500" aria-hidden>
        <span className="w-6 shrink-0" />
        <div className="grid min-w-0 flex-1 gap-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {Array.from({ length: columns }, (_, column) => (
            <span key={column} className="min-w-0 overflow-visible whitespace-nowrap">
              {columnLabelEvery > 0 && column % columnLabelEvery === 0 ? column : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
