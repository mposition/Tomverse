"use client";

import { ExternalLink } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { providerLabel } from "@/components/imports/importFormatting";
import type {
    ExternalImportGuidanceEntry,
    ExternalImportGuidanceProvider,
} from "@/lib/externalImportWizard";

/**
 * Step 1 — getting the export file.
 *
 * The single largest drop-off in the first version of this screen was here:
 * the page opened on a file picker for a file most people did not have yet.
 * So the step asks which service the conversations come from, shows that
 * provider's export recipe, and splits the two very different situations
 * ("I need to request an export" vs "I already downloaded it").
 *
 * The provider chosen here is **guidance only** (`guidanceProvider`). The
 * format that actually gets used is whatever the worker adapters' detect()
 * reports; a mismatch is a non-blocking notice in the next step, never a
 * failure.
 */

const PROVIDER_CARDS: ReadonlyArray<{
    provider: ExternalImportGuidanceProvider;
    titleKey: string;
    stepKeys: readonly string[];
}> = [
    {
        provider: "chatgpt",
        titleKey: "externalImport.guideChatgptTitle",
        stepKeys: [
            "externalImport.guideChatgptStep1",
            "externalImport.guideChatgptStep2",
            "externalImport.guideChatgptStep3",
        ],
    },
    {
        provider: "claude",
        titleKey: "externalImport.guideClaudeTitle",
        stepKeys: [
            "externalImport.guideClaudeStep1",
            "externalImport.guideClaudeStep2",
            "externalImport.guideClaudeStep3",
        ],
    },
    {
        // Takeout's own "Gemini" product is Gems and scheduled actions, not
        // conversations -- picking it hands the user a file with no chats in
        // it (A2 §1). The recipe names My Activity and the JSON format
        // because that mistake is otherwise the common path, not the rare one.
        provider: "gemini",
        titleKey: "externalImport.guideGeminiTitle",
        stepKeys: [
            "externalImport.guideGeminiStep1",
            "externalImport.guideGeminiStep2",
            "externalImport.guideGeminiStep3",
        ],
    },
];

export function ProviderGuideStep({
    guidanceProvider,
    children,
    onChooseProvider,
    onChooseEntry,
}: {
    guidanceProvider: ExternalImportGuidanceProvider | null;
    children: React.ReactNode;
    onChooseProvider: (provider: ExternalImportGuidanceProvider) => void;
    onChooseEntry: (entry: ExternalImportGuidanceEntry) => void;
}) {
    const { t } = useLanguage();

    const card =
        PROVIDER_CARDS.find((item) => item.provider === guidanceProvider) ??
        PROVIDER_CARDS[0];
    const guides = {
        chatgpt:
            "https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data",
        claude: "https://support.claude.com/en/articles/9450526-export-your-claude-data",
        gemini: "https://support.google.com/accounts/answer/3024190",
    };
    return (
        <div data-testid="external-import-guide" className="space-y-5">
            <header>
                <h2>{t("journey.where")}</h2>
                <p>{t("externalImport.guideDescription")}</p>
            </header>
            <div
                role="group"
                aria-label={t("externalImport.guideTitle")}
                className="grid grid-cols-3 gap-2"
            >
                {PROVIDER_CARDS.map((item) => (
                    <button
                        type="button"
                        key={item.provider}
                        data-testid={`external-import-guide-${item.provider}`}
                        aria-pressed={item === card}
                        className={`min-h-12 rounded-xl border px-1 text-sm font-semibold ${item === card ? "border-blue-600 bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200" : "border-zinc-300 dark:border-zinc-700"}`}
                        onClick={() => {
                            onChooseProvider(item.provider);
                            onChooseEntry("needs_export");
                        }}
                    >
                        {providerLabel(item.provider)}
                    </button>
                ))}
            </div>
            <section className="journey-card">
                <h3>{t(card.titleKey)}</h3>
                <ol className="my-3 list-decimal space-y-1 pl-5 text-sm leading-6">
                    {card.stepKeys.map((key) => (
                        <li key={key}>{t(key)}</li>
                    ))}
                </ol>
                <a
                    href={guides[card.provider]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-blue-600"
                >
                    {t("journey.official")} <ExternalLink size={15} />
                </a>
            </section>
            {children}
            <p>{t("journey.returnGuide")}</p>
            <details data-testid="external-import-privacy-disclosure">
                <summary>{t("externalImport.guidePrivacyDisclosure")}</summary>
                <p>
                    {t("externalImport.guideFormats")}{" "}
                    {t("externalImport.guideMediaExcluded")}{" "}
                    {t("externalImport.privacyNote")}
                </p>
            </details>
        </div>
    );
}
