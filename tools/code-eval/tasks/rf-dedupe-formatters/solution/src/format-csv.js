import { buildRows } from "./rows.js";

// CSV with a header row. Cells containing a comma, quote or newline are quoted.
export function formatCsv(records, columns) {
    const { headers, rows } = buildRows(records, columns);
    const quote = (cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
    return [headers, ...rows].map((cells) => cells.map(quote).join(",")).join("\n");
}
