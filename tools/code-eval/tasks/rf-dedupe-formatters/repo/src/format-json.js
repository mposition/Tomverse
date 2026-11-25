// A JSON array of objects keyed by column label; every value is the formatted text.
export function formatJson(records, columns) {
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
    return JSON.stringify(rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]]))), null, 2);
}
