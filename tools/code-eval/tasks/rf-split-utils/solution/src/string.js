export function capitalize(text) {
    return text ? text[0].toUpperCase() + text.slice(1) : "";
}

export function truncate(text, max, ellipsis = "...") {
    if (text.length <= max) return text;
    return text.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

export function kebabCase(text) {
    return text
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[\s_]+/g, "-")
        .toLowerCase();
}
