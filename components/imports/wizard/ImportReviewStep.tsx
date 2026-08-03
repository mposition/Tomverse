"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    interpolate,
    primaryButtonClass,
    secondaryButtonClass,
} from "@/components/imports/importFormatting";
import type { ServerReview } from "@/lib/externalImportWizard";

/**
 * Step 4 — the confirmation screen.
 *
 * `server_review` is deliberately *not* a spinner. Preparing the review
 * (`preparing_review`) is the busy state; this one is a decision point: the
 * server has told us what it staged, what it skipped as duplicate and what it
 * would shorten, and the user either confirms, narrows the set, or steps back.
 *
 * Narrowing here is a real subset finalize — the staged rows the user unticks
 * are simply left out of `selectedConversationIds`, which is why a quota
 * refusal at this point costs nothing but a smaller second attempt.
 *
 * `finalizing` renders the same content with the actions locked, so the
 * atomic save cannot be double-submitted; the retry underneath keeps the same
 * idempotency key, so a resend is a replay rather than a second import.
 */
export function ImportReviewStep({
    review,
    finalizing,
    onToggleStaged,
    onFinalize,
    onBackToSelection,
    onDiscard,
}: {
    review: ServerReview;
    finalizing: boolean;
    onToggleStaged: (stagedConversationId: string) => void;
    onFinalize: () => void;
    onBackToSelection: () => void;
    onDiscard: () => void;
}) {
    const { t } = useLanguage();
    const selectedCount = review.selectedStagedIds.size;

    if (review.staged.length === 0) {
        return (
            <div data-testid="external-import-review">
                <h2 className="text-base font-bold">
                    {t("externalImport.reviewTitle")}
                </h2>
                <p className="mt-2 text-sm leading-6 text-zinc-500">
                    {t("externalImport.allDuplicates")}
                </p>
                <button
                    type="button"
                    className={`${secondaryButtonClass} mt-4`}
                    onClick={onDiscard}
                >
                    {t("externalImport.startAnother")}
                </button>
            </div>
        );
    }

    return (
        <div data-testid="external-import-review">
            <h2 className="text-base font-bold">
                {t("externalImport.reviewTitle")}
            </h2>
            <p
                className="mt-1 text-sm leading-6 text-zinc-500"
                data-testid="external-import-review-summary"
            >
                {interpolate(t("externalImport.stagedSummary"), {
                    staged: review.staged.length,
                    duplicates: review.duplicatesSkipped,
                })}
            </p>
            {review.truncatedMessages > 0 && (
                <p className="mt-1 text-sm leading-6 text-zinc-500">
                    {interpolate(t("externalImport.stagedTruncated"), {
                        count: review.truncatedMessages,
                    })}
                </p>
            )}
            {review.effectiveExpiresAt && (
                <p
                    className="mt-1 text-xs leading-5 text-zinc-400"
                    data-testid="external-import-review-expiry"
                >
                    {interpolate(t("externalImport.reviewExpiresAt"), {
                        time: new Date(
                            review.effectiveExpiresAt
                        ).toLocaleString(),
                    })}
                </p>
            )}

            <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto pr-1">
                {review.staged.map((conversation) => (
                    <li key={conversation.stagedConversationId}>
                        <label className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
                            <input
                                type="checkbox"
                                className="mt-1 h-4 w-4 shrink-0"
                                checked={review.selectedStagedIds.has(
                                    conversation.stagedConversationId
                                )}
                                disabled={finalizing}
                                data-testid="external-import-review-toggle"
                                onChange={() =>
                                    onToggleStaged(
                                        conversation.stagedConversationId
                                    )
                                }
                            />
                            <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                                    {conversation.title}
                                </span>
                                <span className="mt-0.5 block text-xs leading-5 text-zinc-500">
                                    {interpolate(
                                        t("externalImport.messagesCount"),
                                        { count: conversation.messageCount }
                                    )}
                                    {conversation.truncatedMessageCount > 0 && (
                                        <span className="ml-2 font-semibold text-amber-700 dark:text-amber-300">
                                            {t("externalImport.truncatedBadge")}
                                        </span>
                                    )}
                                </span>
                            </span>
                        </label>
                    </li>
                ))}
            </ul>

            {finalizing && (
                <p
                    className="mt-3 flex items-center gap-2 text-sm font-semibold"
                    role="status"
                    aria-live="polite"
                    data-testid="external-import-finalizing"
                >
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("externalImport.finalizingTitle")}
                    <span className="font-normal text-zinc-500">
                        {t("externalImport.finalizingNotice")}
                    </span>
                </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
                <button
                    type="button"
                    className={primaryButtonClass}
                    data-testid="external-import-finalize"
                    disabled={finalizing || selectedCount === 0}
                    onClick={onFinalize}
                >
                    {finalizing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <CheckCircle2 className="h-4 w-4" />
                    )}
                    {interpolate(t("externalImport.reviewFinalizeCta"), {
                        count: selectedCount,
                    })}
                </button>
                <button
                    type="button"
                    className={secondaryButtonClass}
                    data-testid="external-import-back-step"
                    disabled={finalizing}
                    onClick={onBackToSelection}
                >
                    {t("externalImport.reviewBackToSelection")}
                </button>
                <button
                    type="button"
                    className={secondaryButtonClass}
                    disabled={finalizing}
                    onClick={onDiscard}
                >
                    {t("externalImport.abandonImport")}
                </button>
            </div>
        </div>
    );
}
