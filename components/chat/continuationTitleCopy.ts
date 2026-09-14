import { providerLabel } from "@/components/imports/importFormatting";

/**
 * The translated copy `continuationRowTitle()` fills
 * (lib/continuationTitleContext.ts), gathered once so the conversation list,
 * message search and the import page's continuation menu cannot each word the
 * fallback differently.
 */
export const continuationTitleCopy = (t: (key: string) => string) => ({
    fallbackTemplate: t("continuation.untitledFrom"),
    untitled: t("continuation.quickUntitled"),
    providerLabel,
});
