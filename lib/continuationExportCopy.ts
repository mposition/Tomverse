import { providerLabel } from "@/components/imports/importFormatting";
import { DISPLAY_LANGUAGE_HEADER } from "@/lib/continuationTitleContext";
import { isLanguage, type Language } from "@/lib/language";
import { de } from "@/locales/de";
import { en } from "@/locales/en";
import { es } from "@/locales/es";
import { fr } from "@/locales/fr";
import { ko } from "@/locales/ko";
import { pt } from "@/locales/pt";
import { zh } from "@/locales/zh";

/**
 * The words a TXT export uses to name an unnamed continuation, in the page's
 * language (lib/continuationTitleContext.ts).
 *
 * The file's own header lines stay English; only the title -- which is also
 * the filename -- follows the page, because it has to be the name the list
 * shows. The language arrives as a display hint and is validated against the
 * supported languages; anything else is English.
 */
const DICTIONARIES: Record<Language, typeof en> = { ko, en, zh, fr, de, es, pt };

export function continuationExportCopy(request: Request) {
    const hint = request.headers.get(DISPLAY_LANGUAGE_HEADER)?.trim();
    const dictionary = DICTIONARIES[isLanguage(hint) ? hint : "en"];
    return {
        fallbackTemplate: dictionary.continuation.untitledFrom,
        untitled: dictionary.continuation.quickUntitled,
        providerLabel,
    };
}
