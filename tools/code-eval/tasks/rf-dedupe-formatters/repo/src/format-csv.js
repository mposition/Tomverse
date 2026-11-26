// CSV with a header row. Cells containing a comma, quote or newline are quoted.
export function formatCsv(records, columns) {
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
    const quote = (cell) => (/[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
    return [headers, ...rows].map((cells) => cells.map(quote).join(",")).join("\n");
}
