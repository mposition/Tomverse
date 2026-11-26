// The shared part of every formatter: turns records into a header row and
// rows of display text, one string per cell.

export function formatCell(value, column) {
    if (value === null || value === undefined) return "";
    if (column.type === "date") return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
    if (column.type === "boolean") return value ? "yes" : "no";
    return String(value);
}

export function buildRows(records, columns) {
    return {
        headers: columns.map((column) => column.label ?? column.key),
        rows: records.map((record) => columns.map((column) => formatCell(record[column.key], column))),
    };
}
