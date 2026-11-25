import { coerce } from "./coerce.js";

export function parse(text) {
    const result = {};
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        result[trimmed.slice(0, eq).trim()] = coerce(trimmed.slice(eq + 1));
    }
    return result;
}
