import { buildRows } from "./rows.js";

// A JSON array of objects keyed by column label; every value is the formatted text.
export function formatJson(records, columns) {
    const { headers, rows } = buildRows(records, columns);
    return JSON.stringify(rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i]]))), null, 2);
}
