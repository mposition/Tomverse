import { compare } from "./compare.js";
import { parse } from "./parse.js";

// Supports: exact, *, >=x, >x, <=x, <x, ^x and ~x.
export function satisfies(version, range) {
    const v = parse(version);
    const text = range.trim();
    if (text === "*" || text === "") return true;
    const match = /^(\^|~|>=|<=|>|<|=)?\s*(\S+)$/.exec(text);
    if (!match) throw new TypeError(`invalid range: ${range}`);
    const [, op = "=", base] = match;
    const b = parse(base);
    switch (op) {
        case "=":
            return compare(v, b) === 0;
        case ">":
            return compare(v, b) > 0;
        case ">=":
            return compare(v, b) >= 0;
        case "<":
            return compare(v, b) < 0;
        case "<=":
            return compare(v, b) <= 0;
        case "~":
            return compare(v, b) >= 0 && compare(v, { ...b, minor: b.minor + 1, patch: 0, prerelease: [] }) < 0;
        case "^":
            return compare(v, b) >= 0 && compare(v, { ...b, major: b.major + 1, minor: 0, patch: 0, prerelease: [] }) < 0;
        default:
            throw new TypeError(`invalid range: ${range}`);
    }
}
