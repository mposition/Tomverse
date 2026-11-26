export const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// Returns a new object; neither input is modified. Arrays and scalars are replaced.
export function deepMerge(base, override) {
    const out = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
        if (!(key in override) || override[key] === undefined) out[key] = clone(base[key]);
        else if (isObject(base[key]) && isObject(override[key])) out[key] = deepMerge(base[key], override[key]);
        else out[key] = clone(override[key]);
    }
    return out;
}

function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (isObject(value)) return deepMerge(value, {});
    return value;
}

export function getPath(object, path) {
    let current = object;
    for (const key of path.split(".")) {
        if (!isObject(current) || !(key in current)) return undefined;
        current = current[key];
    }
    return current;
}
