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
