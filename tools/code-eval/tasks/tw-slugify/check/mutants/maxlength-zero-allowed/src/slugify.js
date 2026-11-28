// See README.md for the rules.
export function slugify(text, { maxLength = 80, separator = "-" } = {}) {
    if (!Number.isInteger(maxLength) || maxLength < 0) throw new RangeError("maxLength must be a positive integer");
    if (typeof separator !== "string" || separator === "") throw new RangeError("separator must be a non-empty string");
    const ascii = String(text).normalize("NFKD").replace(/[̀-ͯ]/g, "");
    let slug = ascii.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(separator);
    if (slug.length > maxLength) {
        slug = slug.slice(0, maxLength);
        while (slug.endsWith(separator)) slug = slug.slice(0, -separator.length);
    }
    return slug;
}
