// Serialises rows (arrays of values) to CSV text.
export function toCsv(rows, { delimiter = ",", eol = "\n" } = {}) {
    const needsQuote = (s) => s.includes(delimiter) || /["\r\n]/.test(s);
    return rows
        .map((row) =>
            row
                .map((cell) => {
                    const s = String(cell ?? "");
                    return needsQuote(s) ? `"${s.replaceAll('"', '""')}"` : s;
                })
                .join(delimiter),
        )
        .join(eol);
}
