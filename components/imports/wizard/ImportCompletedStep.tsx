"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    interpolate,
    primaryButtonClass,
    secondaryButtonClass,
} from "@/components/imports/importFormatting";

/** Step 5 — the import is saved and the wizard has nothing left to hold. */
export function ImportCompletedStep({
    finalizedConversations,
    onStartAnother,
}: {
    finalizedConversations: number;
    onStartAnother: () => void;
}) {
    const { t } = useLanguage();
    return (
        <div data-testid="external-import-completed">
            <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-status-success-500" />
                <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {interpolate(t("externalImport.importCompleted"), {
                        count: finalizedConversations,
                    })}
                </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
                <Link
                    href="/settings/imports"
                    className={primaryButtonClass}
                    data-testid="external-import-completed-manage"
                >
                    {t("externalImport.backToImports")}
                </Link>
                <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={onStartAnother}
                >
                    {t("externalImport.startAnother")}
                </button>
            </div>
        </div>
    );
}
