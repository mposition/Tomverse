import { interpolate } from "./interpolate.js";
import { pluralCategory } from "./plural.js";

const languageOf = (locale) => locale.split("-")[0];

export function createI18n({ locale = "en", fallbackLocale = "en", messages }) {
    let current = locale;
    const chain = () => [...new Set([current, languageOf(current), fallbackLocale, languageOf(fallbackLocale)])];
    const find = (key) => {
        for (const candidate of chain()) {
            const table = messages[candidate];
            if (table && Object.hasOwn(table, key)) return table[key];
        }
        return undefined;
    };
    return {
        get locale() {
            return current;
        },
        setLocale(next) {
            current = next;
        },
        has(key) {
            return find(key) !== undefined;
        },
        t(key, params = {}) {
            const message = find(key);
            if (message === undefined) return key;
            let text = message;
            if (typeof message === "object" && message !== null) {
                text = message[pluralCategory(current, params.count, message)] ?? message.other;
            }
            if (typeof text !== "string") return key;
            return interpolate(text, params, current);
        },
    };
}
