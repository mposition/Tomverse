"use client";

import { useLanguage } from "@/components/LanguageProvider";
import { interpolate } from "@/components/imports/importFormatting";
import {
    MAX_PRESERVE_TITLE_IDS,
    type TitleImpact,
} from "@/lib/continuationTitlePreservation";

/**
 * What deleting a source does to the shown names of its continuations (D3).
 *
 * Shown with the memory notice while the delete is armed. An unnamed
 * continuation shows the source's title without storing it, so deleting the
 * source changes the name; the conversation and its messages stay. The notice
 * says how many names change, and offers -- off by default -- to save the
 * source's title as the conversation's own name. It names no title: the
 * confirmation already sits beside the source it is about.
 *
 * Renders nothing when no shown name changes, which is the common case.
 */
export function ContinuationTitleImpactNotice({
    impact,
    keepTitles,
    onKeepTitlesChange,
    stale,
}: {
    impact: TitleImpact | null;
    keepTitles: boolean;
    onKeepTitlesChange: (keep: boolean) => void;
    /** The last delete was refused because something changed since. */
    stale: boolean;
}) {
    const { t } = useLanguage();
    if (!impact && !stale) return null;
    const changingCount = impact?.changingCount ?? 0;
    const preservableCount = impact?.preservableConversationIds.length ?? 0;
    const manualCount = changingCount - preservableCount;
    if (changingCount === 0 && !stale) return null;

    return (
        <div
            className="mt-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            data-testid="source-deletion-title-notice"
        >
            {stale ? (
                <p
                    role="alert"
                    className="font-semibold text-red-600 dark:text-red-300"
                    data-testid="source-deletion-title-stale"
                >
                    {t("externalImport.titleImpactStale")}
                </p>
            ) : null}
            {changingCount > 0 ? (
                <p className={stale ? "mt-2" : undefined} data-testid="source-deletion-title-changing">
                    {interpolate(t("externalImport.titleImpactChanging"), {
                        count: changingCount,
                    })}
                </p>
            ) : null}
            {preservableCount > MAX_PRESERVE_TITLE_IDS ? (
                // More than one delete keeps: not offered, rather than keeping
                // some and silently changing the rest.
                <p className="mt-2" data-testid="source-deletion-title-too-many">
                    {interpolate(t("externalImport.titleImpactTooMany"), {
                        count: preservableCount,
                    })}
                </p>
            ) : preservableCount > 0 ? (
                <>
                    <label className="mt-2 flex items-start gap-2 font-semibold">
                        <input
                            type="checkbox"
                            className="mt-1"
                            checked={keepTitles}
                            onChange={(event) => onKeepTitlesChange(event.target.checked)}
                            aria-describedby="source-deletion-title-keep-note"
                            data-testid="source-deletion-keep-titles"
                        />
                        {interpolate(t("externalImport.titleImpactKeep"), {
                            count: preservableCount,
                        })}
                    </label>
                    <p id="source-deletion-title-keep-note" className="mt-1 pl-5">
                        {t("externalImport.titleImpactKeepNote")}
                    </p>
                </>
            ) : null}
            {manualCount > 0 ? (
                <p className="mt-2" data-testid="source-deletion-title-manual">
                    {interpolate(t("externalImport.titleImpactManual"), {
                        count: manualCount,
                    })}
                </p>
            ) : null}
        </div>
    );
}
