"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * What finishing an import does to memory, said before the user confirms it
 * (docs/policy/external-conversation-import-and-memory.md §11, §16; owner decision
 * 2026-10-24).
 *
 * Finishing an import starts a free extraction over the imported
 * conversations, which sends them to an AI provider. That is a processing
 * activity the user should read about on the screen that triggers it, not
 * only in the privacy policy. Shown only when it is true: the extraction
 * rollout flag is on (the run list answers MEMORY_FEATURE_DISABLED
 * otherwise) and the account has not turned memory off.
 */
export function ImportMemoryNotice() {
    const { t } = useLanguage();
    const [applies, setApplies] = useState(false);

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            fetch("/api/memories/extraction-runs", { cache: "no-store" }),
            fetch("/api/memories/settings", { cache: "no-store" }),
        ])
            .then(async ([runsResponse, settingsResponse]) => {
                await discardResponseBody(runsResponse);
                if (cancelled || !runsResponse.ok || !settingsResponse.ok) {
                    await discardResponseBody(settingsResponse);
                    return;
                }
                const settings = (await settingsResponse.json()) as {
                    masterEnabled?: boolean;
                } | null;
                if (!cancelled) setApplies(settings?.masterEnabled !== false);
            })
            .catch(() => {
                // Unknown reads as "not shown": the notice never claims a run
                // the server may not start.
            });
        return () => {
            cancelled = true;
        };
    }, []);

    if (!applies) return null;
    return (
        <div
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            data-testid="external-import-memory-notice"
        >
            <Brain className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
            <p>
                {t("externalImport.memoryNotice")}{" "}
                <Link
                    href="/settings/memory"
                    className="font-semibold text-blue-600 hover:underline dark:text-blue-300"
                >
                    {t("externalImport.memoryNoticeSettings")}
                </Link>
                {" · "}
                <Link
                    href="/privacy"
                    className="font-semibold text-blue-600 hover:underline dark:text-blue-300"
                >
                    {t("externalImport.memoryNoticePrivacy")}
                </Link>
            </p>
        </div>
    );
}
