import { coerceRaw } from "./coerce.js";

export function parse(text) {
    const result = {};
    let current = result;
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
        const section = /^\[([^\]]+)\]$/.exec(trimmed);
        if (section) {
            current = result;
            for (const part of section[1].trim().split(".")) {
                if (typeof current[part] !== "object" || current[part] === null || Array.isArray(current[part])) current[part] = {};
                current = current[part];
            }
            continue;
        }
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        let key = trimmed.slice(0, eq).trim();
        const value = coerceRaw(trimmed.slice(eq + 1));
        if (key.endsWith("[]")) {
            key = key.slice(0, -2).trim();
            if (!Array.isArray(current[key])) current[key] = [];
            current[key].push(value);
        } else {
            current[key] = value;
        }
    }
    return result;
}
