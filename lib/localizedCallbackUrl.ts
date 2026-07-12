import type { Language } from "@/components/LanguageProvider";

const APP_LANGUAGES = new Set(["ko", "en", "zh", "fr", "de", "es", "pt"]);

export function isAppLanguage(value: unknown): value is Language {
    return typeof value === "string" && APP_LANGUAGES.has(value);
}

export function withChatLanguage(callbackUrl: string | null | undefined, lang: Language) {
    const fallback = `/chat?lang=${encodeURIComponent(lang)}`;
    const source = callbackUrl || "/chat";

    try {
        const isAbsoluteUrl = /^https?:\/\//i.test(source);
        const parsed = new URL(source, "https://tomverse.app");

        if (parsed.pathname === "/chat" && !isAppLanguage(parsed.searchParams.get("lang"))) {
            parsed.searchParams.set("lang", lang);
        }

        if (isAbsoluteUrl) return parsed.toString();
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return fallback;
    }
}
