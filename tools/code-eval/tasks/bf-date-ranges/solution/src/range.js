// Half-open time ranges [start, end) over numbers (timestamps).

export const overlaps = (a, b) => a.start < b.end && b.start < a.end;

export const contains = (range, t) => t >= range.start && t < range.end;

export const length = (range) => range.end - range.start;

export function assertRange(range) {
    if (!(range.end >= range.start)) throw new RangeError("range ends before it starts");
    return range;
}
