import { interpolate } from "./interpolate.js";

export function createI18n({ locale = "en", messages }) {
    let current = locale;
    return {
        get locale() {
            return current;
        },
        setLocale(next) {
            current = next;
        },
        has(key) {
            return typeof messages[current]?.[key] === "string";
        },
        t(key, params = {}) {
            const message = messages[current]?.[key];
            if (typeof message !== "string") return key;
            return interpolate(message, params);
        },
    };
}
