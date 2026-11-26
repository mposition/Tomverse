import { ConfigError } from "./errors.js";

export function coerce(text, name) {
    if (text === "true") return true;
    if (text === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    if (text.startsWith("json:")) {
        try {
            return JSON.parse(text.slice(5));
        } catch {
            throw new ConfigError(`invalid JSON in ${name}`);
        }
    }
    return text;
}

export function setPath(target, segments, value) {
    let current = target;
    for (const key of segments.slice(0, -1)) {
        if (typeof current[key] !== "object" || current[key] === null || Array.isArray(current[key])) current[key] = {};
        current = current[key];
    }
    current[segments.at(-1)] = value;
}

export function fromEnv(env = {}, prefix = "APP_") {
    const out = {};
    for (const [name, text] of Object.entries(env)) {
        if (!name.startsWith(prefix) || typeof text !== "string") continue;
        const segments = name.slice(prefix.length).toLowerCase().split("__").filter(Boolean);
        if (segments.length === 0) continue;
        setPath(out, segments, coerce(text, name));
    }
    return out;
}
