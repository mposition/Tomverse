/**
 * The excerpt a message search hit shows.
 *
 * Centred on the first match rather than cut from the start: an imported
 * transcript turn can run to tens of thousands of characters, and an excerpt
 * of its opening sentence tells the reader nothing about why it matched.
 *
 * Counted in code points, never UTF-16 units, so a cut can never split a
 * surrogate pair into a lone half (the same failure that made the TXT filename
 * throw `URIError`). The match is located case-insensitively the way the
 * database's `ILIKE` found it; when the two disagree -- a character whose
 * lower-case form changes its length -- the excerpt falls back to the opening
 * and reports no highlight, rather than highlighting the wrong span.
 *
 * `highlight` is offsets into the returned `text`, in code points' UTF-16
 * positions (what `String.prototype.slice` takes), for the client to draw as a
 * text node. Nothing here produces markup.
 */
export type SearchSnippet = {
    text: string;
    highlight: { start: number; end: number } | null;
};

export const SEARCH_SNIPPET_RADIUS = 80;
const FALLBACK_LENGTH = 180;
const ELLIPSIS = "…";

export function searchSnippet(
    content: string,
    query: string,
    radius: number = SEARCH_SNIPPET_RADIUS
): SearchSnippet {
    const points = Array.from(content);
    const needle = Array.from(query.trim());
    const matchAt = needle.length > 0 ? findFolded(points, needle) : -1;

    if (matchAt < 0) {
        const head = points.slice(0, FALLBACK_LENGTH).join("");
        return {
            text: points.length > FALLBACK_LENGTH ? `${head}${ELLIPSIS}` : head,
            highlight: null,
        };
    }

    const from = Math.max(0, matchAt - radius);
    const to = Math.min(points.length, matchAt + needle.length + radius);
    const prefix = from > 0 ? ELLIPSIS : "";
    const before = points.slice(from, matchAt).join("");
    const match = points.slice(matchAt, matchAt + needle.length).join("");
    const after = points.slice(matchAt + needle.length, to).join("");
    const suffix = to < points.length ? ELLIPSIS : "";
    const start = prefix.length + before.length;
    return {
        text: `${prefix}${before}${match}${after}${suffix}`,
        highlight: { start, end: start + match.length },
    };
}

/**
 * First index where `needle` matches `points`, comparing one code point at a
 * time after lower-casing each. Per code point so the index stays a code point
 * index; a code point whose lower-case form is not one code point is compared
 * as-is, which can only miss a match, never invent one.
 */
function findFolded(points: readonly string[], needle: readonly string[]): number {
    const fold = (point: string) => {
        const lower = point.toLowerCase();
        return Array.from(lower).length === 1 ? lower : point;
    };
    const foldedNeedle = needle.map(fold);
    const folded = points.map(fold);
    outer: for (let i = 0; i + foldedNeedle.length <= folded.length; i += 1) {
        for (let j = 0; j < foldedNeedle.length; j += 1) {
            if (folded[i + j] !== foldedNeedle[j]) continue outer;
        }
        return i;
    }
    return -1;
}
