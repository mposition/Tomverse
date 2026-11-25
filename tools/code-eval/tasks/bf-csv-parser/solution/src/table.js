// Turns parsed rows into objects keyed by the header row.
export function toObjects(rows) {
    const [header = [], ...body] = rows;
    return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""])));
}
