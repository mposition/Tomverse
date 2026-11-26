// Reads a dotted path such as "user.address.city" from nested objects.
export function lookup(data, path) {
    let current = data;
    for (const key of path.split(".")) {
        if (current === null || current === undefined) return undefined;
        current = current[key];
    }
    return current;
}
