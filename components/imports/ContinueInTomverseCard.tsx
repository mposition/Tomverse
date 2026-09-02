"use client";

import { useCallback, useState } from "react";
import { ArrowRight, Loader2, MessageSquare } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import { useContinuationLauncher } from "@/components/imports/useContinuationLauncher";

/**
 * "Tomverse에서 이어가기" — the disclosed way to start a continuation.
 *
 * Policy: docs/policy/external-conversation-continuation.md §8.
 *
 * ## Why the disclosure is before the action and not after it
 *
 * Five sentences the owner has to be able to read *before* pressing anything,
 * because each of them is something they would otherwise discover by being
 * surprised: a new conversation appears, the original does not move, the
 * imported replies are not Tomverse's, files did not come across, and only a
 * recent slice of the transcript reaches the model. A confirmation dialog that
 * appears after the conversation exists would be a notification, not a choice.
 *
 * The list's quick action skips this disclosure deliberately, and is allowed
 * to: it is reached from a screen the owner opened to manage imports, and the
 * sentences above describe what they are already looking at. This card is
 * where somebody meets the feature for the first time.
 *
 * ## Where the idempotency key lives
 *
 * Not here. `useContinuationLauncher` owns it, because this card and the
 * list's quick action must not be able to disagree about what a retry is —
 * see the contract in that file. This component owns the disclosure and
 * nothing else.
 */

/**
 * Whether the disclosure is open. The request's own state -- creating,
 * failed, and the key behind it -- belongs to the launcher, so this type has
 * shrunk to the one thing the card actually decides.
 */
type CardState = { kind: "idle" } | { kind: "armed" };

export function ContinueInTomverseCard({
    externalConversationId,
    /**
     * Whether this snapshot can be continued at all. False for a locked
     * snapshot the browser has no grant for -- the viewer is showing the
     * password gate in that case and the CTA would be an action the server is
     * about to refuse.
     */
    enabled = true,
}: {
    externalConversationId: string;
    enabled?: boolean;
}) {
    const { t } = useLanguage();
    const [state, setState] = useState<CardState>({ kind: "idle" });
    const launcher = useContinuationLauncher({ externalConversationId });
    const creating = launcher.status === "creating";

    // Arming does not mint anything. A failed attempt collapses back to this
    // CTA, so pressing it again is a retry of that attempt and must keep its
    // key; only `launcher.cancel()` below says otherwise.
    const arm = useCallback(() => setState({ kind: "armed" }), []);

    if (!enabled) return null;

    return (
        <section
            className="mt-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950/60"
            data-testid="continuation-cta-card"
        >
            <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-900 dark:text-zinc-100">
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
                {t("continuation.ctaTitle")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-zinc-500">
                {t("continuation.ctaDescription")}
            </p>

            {state.kind === "idle" ? (
                <>
                    <button
                        type="button"
                        className="mt-3 inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                        data-testid="continuation-cta"
                        onClick={arm}
                    >
                        {t("continuation.ctaAction")}
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </button>
                    {launcher.status === "failed" ? (
                        <p
                            className="mt-2 text-sm leading-6 text-red-600 dark:text-red-300"
                            role="status"
                            data-testid="continuation-cta-error"
                        >
                            {launcher.errorMessage}
                        </p>
                    ) : null}
                </>
            ) : null}

            {state.kind === "armed" ? (
                <div
                    className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60"
                    data-testid="continuation-disclosure"
                >
                    <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                        <li>{t("continuation.disclosureNewConversation")}</li>
                        <li>{t("continuation.disclosureSourceReadOnly")}</li>
                        <li>{t("continuation.disclosureNotOurAnswer")}</li>
                        <li>{t("continuation.disclosureAttachments")}</li>
                        <li>{t("continuation.disclosurePartialContext")}</li>
                        {/* The sixth, and the only one about money: a
                            continuation is a Review conversation, so every
                            selected model answers and each one is charged
                            (docs/policy/external-conversation-continuation.md
                            §8.1). The other five say what is preserved; this
                            one says what it costs, and it is said before the
                            conversation exists rather than after. */}
                        <li>{t("continuation.disclosureMultiModel")}</li>
                    </ul>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <button
                            type="button"
                            className="inline-flex items-center gap-2 rounded-xl border border-zinc-900 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                            data-testid="continuation-confirm"
                            disabled={creating}
                            onClick={() => {
                                void (async () => {
                                    // Failure collapses the disclosure back to
                                    // the CTA, which is the retry. The launcher
                                    // keeps its key across that, so the next
                                    // press is the same attempt.
                                    const created = await launcher.start();
                                    if (!created) setState({ kind: "idle" });
                                })();
                            }}
                        >
                            {creating ? (
                                <Loader2
                                    className="h-4 w-4 animate-spin"
                                    aria-hidden="true"
                                />
                            ) : null}
                            {creating
                                ? t("continuation.creating")
                                : t("continuation.confirm")}
                        </button>
                        <button
                            type="button"
                            className="inline-flex items-center rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            data-testid="continuation-cancel"
                            disabled={creating}
                            onClick={() => {
                                // A new attempt from here is a new fork, so the
                                // launcher drops its key. This is the only
                                // place in the product that does.
                                launcher.cancel();
                                setState({ kind: "idle" });
                            }}
                        >
                            {t("continuation.cancel")}
                        </button>
                    </div>
                </div>
            ) : null}
        </section>
    );
}
