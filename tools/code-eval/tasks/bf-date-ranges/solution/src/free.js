import { mergeRanges } from "./merge.js";

// The gaps inside `window` that no busy range covers.
export function freeSlots(busy, window) {
    const free = [];
    let cursor = window.start;
    for (const range of mergeRanges(busy)) {
        if (cursor >= window.end) break;
        if (range.start > cursor) free.push({ start: cursor, end: Math.min(range.start, window.end) });
        cursor = Math.max(cursor, range.end);
    }
    if (cursor < window.end) free.push({ start: cursor, end: window.end });
    return free;
}
