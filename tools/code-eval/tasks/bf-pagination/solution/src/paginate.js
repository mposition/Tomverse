// Pagination arithmetic. Pages are 1-based.

export function pageCount(total, size) {
    if (total <= 0) return 1;
    return Math.ceil(total / size);
}

export function sliceFor(items, page, size) {
    const start = (page - 1) * size;
    return items.slice(start, start + size);
}
