export function chunk(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

export function unique(items) {
    return [...new Set(items)];
}

export function groupBy(items, keyOf) {
    const groups = {};
    for (const item of items) (groups[keyOf(item)] ??= []).push(item);
    return groups;
}

export function sortBy(items, keyOf) {
    return [...items].sort((a, b) => {
        const x = keyOf(a);
        const y = keyOf(b);
        return x < y ? -1 : x > y ? 1 : 0;
    });
}
