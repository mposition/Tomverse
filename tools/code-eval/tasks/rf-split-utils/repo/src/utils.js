// String helpers
export function capitalize(text) {
    return text ? text[0].toUpperCase() + text.slice(1) : "";
}

export function truncate(text, max, ellipsis = "...") {
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

export function kebabCase(text) {
    return text
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[\s_]+/g, "-")
        .toLowerCase();
}

// Array helpers
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

// Object helpers
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export function pick(object, keys) {
    return Object.fromEntries(keys.filter((k) => k in object).map((k) => [k, object[k]]));
}

export function omit(object, keys) {
    return Object.fromEntries(Object.entries(object).filter(([k]) => !keys.includes(k)));
}

export function mapValues(object, fn) {
    return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, fn(v, k)]));
}

export function deepGet(object, path, fallback) {
    let current = object;
    for (const key of path.split(".")) {
        if (!isPlainObject(current) || !(key in current)) return fallback;
        current = current[key];
    }
    return current;
}
