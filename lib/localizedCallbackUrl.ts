import { isLanguage, type Language } from "@/lib/language";
import { PRODUCT_SURFACE_PATH } from "@/lib/productSurfaceRoutes";

export function isAppLanguage(value: unknown): value is Language {
    return isLanguage(value);
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
