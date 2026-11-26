import { parse } from "./parse.js";

const numeric = (id) => /^\d+$/.test(id);

function comparePrerelease(a, b) {
    // A version without a pre-release is higher than one with a pre-release.
    if (a.length === 0 && b.length === 0) return 0;
    if (a.length === 0) return 1;
    if (b.length === 0) return -1;
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) {
        if (a[i] === b[i]) continue;
        const an = numeric(a[i]);
        const bn = numeric(b[i]);
        if (an && bn) return Number(a[i]) < Number(b[i]) ? -1 : 1;
        if (an) return -1;
        if (bn) return 1;
        return a[i] < b[i] ? -1 : 1;
    }
    return Math.sign(a.length - b.length);
}

export function compare(left, right) {
    const a = typeof left === "string" ? parse(left) : left;
    const b = typeof right === "string" ? parse(right) : right;
    for (const part of ["major", "minor", "patch"]) {
        if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
    }
    return Math.sign(comparePrerelease(a.prerelease, b.prerelease));
}

export const isNumericId = numeric;
