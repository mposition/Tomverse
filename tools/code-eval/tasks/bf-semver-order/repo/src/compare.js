import { parse } from "./parse.js";

const numeric = (id) => /^\d+$/.test(id);

function comparePrerelease(a, b) {
    if (a.length !== b.length) return a.length - b.length;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        return a[i] < b[i] ? -1 : 1;
    }
    return 0;
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
