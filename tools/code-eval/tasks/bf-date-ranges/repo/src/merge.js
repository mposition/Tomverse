import { assertRange } from "./range.js";

// Merges overlapping or touching ranges and returns them sorted by start.
export function mergeRanges(ranges) {
    const sorted = ranges.map(assertRange).sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of sorted) {
        const last = merged[merged.length - 1];
        if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
        else merged.push(range);
    }
    return merged;
}
