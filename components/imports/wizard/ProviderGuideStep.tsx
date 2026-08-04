"use client";

import { FileArchive, Lock, ImageOff, FileJson } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    primaryButtonClass,
    secondaryButtonClass,
} from "@/components/imports/importFormatting";
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
];

export function ProviderGuideStep({
    guidanceProvider,
    guidanceEntry,
    onChooseProvider,
    onChooseEntry,
    onContinue,
}: {
    guidanceProvider: ExternalImportGuidanceProvider | null;
    guidanceEntry: ExternalImportGuidanceEntry | null;
    onChooseProvider: (provider: ExternalImportGuidanceProvider) => void;
    onChooseEntry: (entry: ExternalImportGuidanceEntry) => void;
    onContinue: () => void;
}) {
    const { t } = useLanguage();

    return (
        <div data-testid="external-import-guide">
            <h2 className="text-base font-bold">
                {t("externalImport.guideTitle")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
                {t("externalImport.guideDescription")}
            </p>

            <div
                className="mt-4 grid gap-3 sm:grid-cols-2"
                role="group"
                aria-label={t("externalImport.guideTitle")}
            >
                {PROVIDER_CARDS.map((card) => {
                    const selected = guidanceProvider === card.provider;
                    return (
                        <button
                            key={card.provider}
                            type="button"
                            aria-pressed={selected}
                            data-testid={`external-import-guide-${card.provider}`}
                            onClick={() => onChooseProvider(card.provider)}
                            className={`rounded-2xl border p-3.5 text-left transition-colors ${
                                selected
                                    ? "border-blue-500 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/30"
                                    : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                            }`}
                        >
                            <span className="block text-sm font-bold text-zinc-900 dark:text-zinc-100">
                                {t(card.titleKey)}
                            </span>
                            <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-5 text-zinc-500">
                                {card.stepKeys.map((key) => (
                                    <li key={key}>{t(key)}</li>
                                ))}
                            </ol>
                        </button>
                    );
                })}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
                <button
                    type="button"
                    aria-pressed={guidanceEntry === "needs_export"}
                    data-testid="external-import-guide-needs-export"
                    className={
                        guidanceEntry === "needs_export"
                            ? primaryButtonClass
                            : secondaryButtonClass
                    }
                    onClick={() => onChooseEntry("needs_export")}
                >
                    {t("externalImport.guideEntryNeedsExport")}
                </button>
                <button
                    type="button"
                    aria-pressed={guidanceEntry === "has_file"}
                    data-testid="external-import-guide-has-file"
                    className={
                        guidanceEntry === "has_file"
                            ? primaryButtonClass
                            : secondaryButtonClass
                    }
                    onClick={() => {
                        onChooseEntry("has_file");
                        onContinue();
                    }}
                >
                    {t("externalImport.guideEntryHasFile")}
                </button>
            </div>

            <ul className="mt-4 grid gap-1.5 text-xs leading-5 text-zinc-500">
                <li className="flex items-start gap-2">
                    <FileJson className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t("externalImport.guideFormats")}
                </li>
                <li className="flex items-start gap-2">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t("externalImport.guideStaysLocal")}
                </li>
                <li className="flex items-start gap-2">
                    <ImageOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t("externalImport.guideMediaExcluded")}
                </li>
            </ul>

            {/* The full privacy statement is long enough to bury the three
                lines above, so it lives behind a native disclosure that keeps
                its expanded state exposed to assistive technology. */}
            <details
                className="mt-3 rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                data-testid="external-import-privacy-disclosure"
            >
                <summary className="cursor-pointer text-xs font-semibold text-zinc-600 dark:text-zinc-300">
                    {t("externalImport.guidePrivacyDisclosure")}
                </summary>
                <p className="mt-2 text-xs leading-5 text-zinc-500">
                    {t("externalImport.privacyNote")}
                </p>
            </details>

            {guidanceEntry !== "has_file" && (
                <button
                    type="button"
                    className={`${primaryButtonClass} mt-4`}
                    data-testid="external-import-guide-continue"
                    onClick={onContinue}
                >
                    <FileArchive className="h-4 w-4" />
                    {t("externalImport.guideContinue")}
                </button>
            )}
        </div>
    );
}
