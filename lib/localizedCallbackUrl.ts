import type { Language } from "@/components/LanguageProvider";
import { PRODUCT_SURFACE_PATH } from "@/lib/productSurfaceRoutes";

const APP_LANGUAGES = new Set(["ko", "en", "zh", "fr", "de", "es", "pt"]);

export function isAppLanguage(value: unknown): value is Language {
    return typeof value === "string" && APP_LANGUAGES.has(value);
}

export function withChatLanguage(callbackUrl: string | null | undefined, lang: Language) {
    const fallback = `${PRODUCT_SURFACE_PATH.review}?lang=${encodeURIComponent(lang)}`;
    const source = callbackUrl || PRODUCT_SURFACE_PATH.review;

    try {
        const parsed = new URL(source, "https://tomverse.app");
        const isInternalPath =
            source.startsWith("/") &&
            !source.startsWith("//") &&
            parsed.origin === "https://tomverse.app";
        if (!isInternalPath) return fallback;

        if (
            (parsed.pathname === PRODUCT_SURFACE_PATH.chat ||
                parsed.pathname === PRODUCT_SURFACE_PATH.review) &&
            !isAppLanguage(parsed.searchParams.get("lang"))
        ) {
            parsed.searchParams.set("lang", lang);
        }

        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return fallback;
    }
}
