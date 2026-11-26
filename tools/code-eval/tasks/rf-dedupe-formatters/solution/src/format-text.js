import { buildRows } from "./rows.js";

// Plain-text table: header, a dashed rule, then one line per record.
export function formatText(records, columns) {
    const { headers, rows } = buildRows(records, columns);
    const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
    const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
