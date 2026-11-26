// Plain-text table: header, a dashed rule, then one line per record.
export function formatText(records, columns) {
    const headers = columns.map((column) => column.label ?? column.key);
    const rows = records.map((record) =>
        columns.map((column) => {
            const value = record[column.key];
            if (value === null || value === undefined) return "";
            if (column.type === "date") return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
            if (column.type === "boolean") return value ? "yes" : "no";
            return String(value);
        }),
    );
    const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
    const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
