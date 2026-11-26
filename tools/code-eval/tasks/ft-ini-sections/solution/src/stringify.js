const isPlain = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function needsQuotes(text) {
    return (
        text === "" ||
        text !== text.trim() ||
        text === "true" ||
        text === "false" ||
        /^-?\d+(\.\d+)?$/.test(text) ||
        /["\\\n]/.test(text) ||
        /\s[;#]/.test(text) ||
        /^[;#[]/.test(text)
    );
}

function format(value) {
    if (typeof value !== "string") return String(value);
    if (!needsQuotes(value)) return value;
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function writeObject(object, path, out) {
    const lines = [];
    for (const [key, value] of Object.entries(object)) {
        if (value === null || value === undefined || isPlain(value)) continue;
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}[] = ${format(item)}`);
        else lines.push(`${key} = ${format(value)}`);
    }
    if (path) out.push(`[${path}]`);
    out.push(...lines);
    for (const [key, value] of Object.entries(object)) {
        if (isPlain(value)) writeObject(value, path ? `${path}.${key}` : key, out);
    }
}

export function stringify(object) {
    const out = [];
    writeObject(object, "", out);
    return out.length ? `${out.join("\n")}\n` : "";
}
