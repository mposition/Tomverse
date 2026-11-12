/** A turn carries source coordinates only. Text always comes from the authorised snapshot. */
export const PASSAGE_HEADER = "x-tomverse-source-passages";
export const PASSAGE_LENGTH = 500;
export const MAX_PASSAGES = 3;
export type Passage = { ordinal: number; start: number; end: number };
export function decodePassages(value: string | null): Passage[] | null {
    if (value === null) return null;
    if (!value || value.length > 128) return [];
    const parts = value.split(",");
    if (parts.length > MAX_PASSAGES) return [];
    const seen = new Set<number>();
    const result: Passage[] = [];
    for (const part of parts) {
        if (!/^[0-9]{1,8}:[0-9]{1,8}:[0-9]{1,8}$/.test(part)) return [];
        const [ordinal, start, end] = part.split(":").map(Number);
        if (seen.has(ordinal) || end <= start || end - start > PASSAGE_LENGTH)
            return [];
        seen.add(ordinal);
        result.push({ ordinal, start, end });
    }
    return result;
}
export const encodePassages = (passages: readonly Passage[]) =>
    passages.map((p) => [p.ordinal, p.start, p.end].join(":")).join(",");

/** Keep the selected UTF-16 range without emitting half of an emoji at either edge. */
export function slicePassage(text: string, start: number, end: number) {
    return text.slice(start, end).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, "");
}

/** Coordinates cannot introduce text: the caller supplies only rows from the checked source. */
export function selectPassageText<
    T extends { ordinal: number; content: string; truncated: boolean },
>(rows: readonly T[], passages: readonly Passage[]) {
    return rows.flatMap((row) => {
        const part = passages.find((p) => p.ordinal === row.ordinal);
        if (!part || part.end > row.content.length) return [];
        const content = slicePassage(row.content, part.start, part.end);
        if (!content) return [];
        return [
            {
                ...row,
                content,
                truncated:
                    row.truncated ||
                    part.start !== 0 ||
                    part.end !== row.content.length,
            },
        ];
    });
}
