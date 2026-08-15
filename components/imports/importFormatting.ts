import {
    isExternalImportProvider,
    type ExternalImportProvider,
} from "@/lib/externalImportProviders";

/**
 * Formatting helpers shared by the import management screen, the wizard and
 * the read-only viewer. Pure and locale-agnostic on purpose: the localized
 * strings live in `locales/*.ts` and these only fill their placeholders.
 */

export const interpolate = (
    template: string,
    values: Record<string, string | number>
) =>
    Object.entries(values).reduce(
        (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
        template
    );

export const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/**
 * Provider brand names are not translated; they are what the user saw.
 *
 * Keyed by the canonical provider set, so a provider added there without a
 * label here is a type error rather than a lowercase id shown to the user --
 * which is what "gemini" was until A2's server side landed.
 */
const PROVIDER_LABELS: Record<ExternalImportProvider, string> = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    gemini: "Gemini",
};

export const providerLabel = (provider: string) =>
    isExternalImportProvider(provider) ? PROVIDER_LABELS[provider] : provider;

export const sectionClass =
    "rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60";

export const primaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButtonClass =
    "inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
