import { pageCount, sliceFor } from "./paginate.js";
import { parsePagination } from "./query.js";

export function listPage(items, query = {}) {
    const parsed = parsePagination(query);
    const size = parsed.size;
    const pages = pageCount(items.length, size);
    const page = Math.min(parsed.page, pages);
    return {
        items: sliceFor(items, page, size),
        page,
        size,
        pageCount: pages,
        total: items.length,
        hasPrev: page > 1,
        hasNext: page < pages,
    };
}
