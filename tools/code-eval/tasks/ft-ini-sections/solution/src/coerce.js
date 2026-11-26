// Turns the raw text of a value into a JS value.
const ESCAPES = { n: "\n", '"': '"', "\\": "\\" };

export function unquote(text) {
    return text.slice(1, -1).replace(/\\([n"\\])/g, (_, ch) => ESCAPES[ch]);
}

export function coerce(raw) {
    const text = raw.trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return unquote(text);
    const comment = text.search(/\s[;#]/);
    const value = (comment < 0 ? text : text.slice(0, comment)).trim();
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value;
}

// A quoted value may be followed by an inline comment: "a b" ; note
export function coerceRaw(raw) {
    const text = raw.trim();
    if (text.startsWith('"')) {
        let i = 1;
        while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
        if (i < text.length) return unquote(text.slice(0, i + 1));
    }
    return coerce(text);
}
