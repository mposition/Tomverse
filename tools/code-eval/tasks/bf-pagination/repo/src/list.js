import { pageCount, sliceFor } from "./paginate.js";
import { parsePagination } from "./query.js";

export function listPage(items, query = {}) {
    const { page, size } = parsePagination(query);
    const pages = pageCount(items.length, size);
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
