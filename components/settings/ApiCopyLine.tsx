"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";

/**
 * One connection address on one line, with its own copy button. Shared by the
 * Developer tab and the API keys page, so the two show an address the same way.
 */
export function ApiCopyLine({ label, value, testId }: { label: string; value: string; testId: string }) {
    const { t } = useLanguage();
    const [copied, setCopied] = useState(false);
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="w-32 shrink-0 text-xs font-semibold text-zinc-500">{label}</span>
            <code data-testid={testId} className="min-w-0 flex-1 break-all rounded-lg bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
                {value}
            </code>
            <button
                type="button"
                data-testid={`${testId}-copy`}
                onClick={() => {
                    // A denied clipboard permission leaves the button as it was;
                    // the address stays on screen to copy by hand.
                    void navigator.clipboard
                        ?.writeText(value)
                        .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        })
                        .catch(() => undefined);
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
                {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                {copied ? t("externalApi.copied") : t("externalApi.copy")}
            </button>
        </div>
    );
}
