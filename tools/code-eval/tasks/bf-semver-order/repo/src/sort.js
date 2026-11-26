import { compare } from "./compare.js";
import { satisfies } from "./range.js";

export const sortVersions = (versions) => [...versions].sort(compare);

export function maxSatisfying(versions, range) {
    const matching = versions.filter((v) => satisfies(v, range));
    return matching.length ? sortVersions(matching).at(-1) : null;
}
