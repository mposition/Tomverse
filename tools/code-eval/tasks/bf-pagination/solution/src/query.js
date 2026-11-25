// Reads ?page= and ?size= from an already-parsed query object.

export const DEFAULTS = { page: 1, size: 10, maxSize: 100 };

export function parsePagination(query = {}, defaults = DEFAULTS) {
    const page = Number.parseInt(query.page, 10);
    const size = Number.parseInt(query.size, 10);
    return {
        page: page > 0 ? page : defaults.page,
        size: size > 0 ? Math.min(size, defaults.maxSize) : defaults.size,
    };
}
