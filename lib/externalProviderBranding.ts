import type { AiProvider } from "@/lib/models";
import {
    isExternalImportProvider,
    type ExternalImportProvider,
} from "@/lib/externalImportProviders";

/**
 * Which model-catalogue brand stands for an imported conversation's service.
 *
 * The three services this deployment can import from are the same three
 * companies whose models it serves, and `lib/modelBranding.ts` already holds
 * their marks and logo assets. So this is a two-column table and nothing else:
 * no new SVG, no second copy of a logo, and no hard-coded brand colour, all of
 * which would be a second source of truth for something the catalogue already
 * answers (docs/ui-contracts/typography.md's reasoning applies to icons too --
 * one registry, or two that drift).
 *
 * `null` for a value this build does not recognise. The bridge keeps its
 * `provider` column deliberately -- "provenance kept after the source is
 * gone" -- so a continuation whose snapshot was deleted still names its
 * service, and the generic fallback is for a provider a newer server knows
 * and this client does not.
 */
const BRAND_PROVIDER: Record<ExternalImportProvider, AiProvider> = {
    chatgpt: "openai",
    claude: "anthropic",
    gemini: "google",
};

export function externalProviderBrand(
    provider: string | null | undefined
): AiProvider | null {
    if (!provider || !isExternalImportProvider(provider)) return null;
    return BRAND_PROVIDER[provider];
}
