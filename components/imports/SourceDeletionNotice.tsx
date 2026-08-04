"use client";

import { useLanguage } from "@/components/LanguageProvider";
import { interpolate } from "@/components/imports/importFormatting";

/**
 * What deleting a source will do to the memories made from it (§13.1).
 *
 * Shown while the delete is armed and before it is confirmed, because the
 * point of the §13.1 choice is that the user makes it knowing the number. It
 * renders nothing when the source has no memories behind it — a notice
 * saying "0 memories" is noise on the common path.
 *
 * The checkbox only covers *derived* memories. Edited ones are never deleted
 * by this control: they are stated separately as being suspended, which is
 * what the server does with them by default.
 */

export type SourceDeletionImpactView = {
    derivedCount: number;
    userTouchedCount: number;
    keptCount: number;
};

export function SourceDeletionNotice({
    impact,
    scope,
    keepDerived,
    onKeepDerivedChange,
}: {
    impact: SourceDeletionImpactView | null;
    scope: "import" | "conversation";
    keepDerived: boolean;
    onKeepDerivedChange: (keep: boolean) => void;
}) {
    const { t } = useLanguage();
    if (!impact) return null;
    const { derivedCount, userTouchedCount, keptCount } = impact;
    if (derivedCount === 0 && userTouchedCount === 0 && keptCount === 0) {
        return null;
    }

    return (
        <div
            className="mt-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            data-testid="source-deletion-memory-notice"
        >
            {derivedCount > 0 ? (
                <>
                    <p data-testid="source-deletion-derived">
                        {interpolate(
                            t(
                                scope === "import"
                                    ? "memoryReview.sourceDeleteDerivedImport"
                                    : "memoryReview.sourceDeleteDerivedConversation"
                            ),
                            { count: derivedCount }
                        )}
                    </p>
                    <label className="mt-2 flex items-center gap-2 font-semibold">
                        <input
                            type="checkbox"
                            checked={keepDerived}
                            onChange={(event) =>
                                onKeepDerivedChange(event.target.checked)
                            }
                            data-testid="source-deletion-keep-memories"
                        />
                        {t("memoryReview.sourceDeleteKeep")}
                    </label>
                </>
            ) : null}
            {userTouchedCount > 0 ? (
                <p className="mt-2" data-testid="source-deletion-edited">
                    {interpolate(t("memoryReview.sourceDeleteEdited"), {
                        count: userTouchedCount,
                    })}
                </p>
            ) : null}
            {keptCount > 0 ? (
                <p className="mt-2" data-testid="source-deletion-kept">
                    {interpolate(t("memoryReview.sourceDeleteKept"), {
                        count: keptCount,
                    })}
                </p>
            ) : null}
        </div>
    );
}
