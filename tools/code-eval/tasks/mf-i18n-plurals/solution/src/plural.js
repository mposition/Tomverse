// Picks the plural form of a message object for `count` in `locale`.
export function pluralCategory(locale, count, message) {
    if (typeof count !== "number" || !Number.isFinite(count)) return "other";
    if (count === 0 && Object.hasOwn(message, "zero")) return "zero";
    return new Intl.PluralRules(locale).select(count);
}
