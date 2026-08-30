"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, MessageSquare } from "lucide-react";

import { useLanguage } from "@/components/LanguageProvider";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { continuationPath } from "@/lib/continuationRoutes";

/**
 * "Tomverse에서 이어가기" — the one place a continuation is started.
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
 * ## Why the idempotency key is minted once per armed card
 *
 * The key identifies *this attempt*. It is generated when the disclosure is
 * opened and reused by every retry of the same attempt, so a double click, a
 * dropped response and a "try again" all resolve to the one conversation the
 * first request created. Cancelling and arming again mints a new key, because
 * that is a second, deliberate fork — which §3 allows.
 */

type CardState =
    | { kind: "idle" }
    | { kind: "armed" }
    | { kind: "creating" }
    | { kind: "failed"; message: string };

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
    const router = useRouter();
    const [state, setState] = useState<CardState>({ kind: "idle" });
    const idempotencyKeyRef = useRef<string | null>(null);

    const arm = useCallback(() => {
        // One key for this attempt, minted here and kept until the card is
        // cancelled. `crypto.randomUUID` is available in every browser this
        // application supports; the fallback exists so a non-secure context
        // (an http:// preview) fails by creating one conversation rather than
        // by throwing before the click does anything.
        idempotencyKeyRef.current =
            typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        setState({ kind: "armed" });
    }, []);

    const create = useCallback(async () => {
        const idempotencyKey = idempotencyKeyRef.current;
        if (!idempotencyKey) return;
        setState({ kind: "creating" });
        try {
            const response = await fetch(
                `/api/external-conversations/${encodeURIComponent(externalConversationId)}/continuations`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ idempotencyKey }),
                }
            );
            if (!response.ok) {
                await discardResponseBody(response);
                setState({
                    kind: "failed",
                    // 403 is the rollout flag, and it is the one refusal with
                    // its own sentence: "not available" is true and "try
                    // again" would not be.
                    message:
                        response.status === 403
                            ? t("continuation.unavailable")
                            : t("continuation.createFailed"),
                });
                return;
            }
            const body = (await response.json()) as { conversationId?: string };
            if (!body.conversationId) {
                setState({ kind: "failed", message: t("continuation.createFailed") });
                return;
            }
            router.push(continuationPath(body.conversationId));
        } catch {
            // The attempt keeps its key, so pressing the button again resolves
            // to whatever the first request created rather than making a
            // second conversation.
            setState({ kind: "failed", message: t("continuation.createFailed") });
        }
    }, [externalConversationId, router, t]);

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

            {state.kind === "idle" || state.kind === "failed" ? (
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
                    {state.kind === "failed" ? (
                        <p
                            className="mt-2 text-sm leading-6 text-red-600 dark:text-red-300"
                            role="status"
                            data-testid="continuation-cta-error"
                        >
                            {state.message}
                        </p>
                    ) : null}
                </>
            ) : null}

            {state.kind === "armed" || state.kind === "creating" ? (
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
                    </ul>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <button
                            type="button"
                            className="inline-flex items-center gap-2 rounded-xl border border-zinc-900 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                            data-testid="continuation-confirm"
                            disabled={state.kind === "creating"}
                            onClick={() => void create()}
                        >
                            {state.kind === "creating" ? (
                                <Loader2
                                    className="h-4 w-4 animate-spin"
                                    aria-hidden="true"
                                />
                            ) : null}
                            {state.kind === "creating"
                                ? t("continuation.creating")
                                : t("continuation.confirm")}
                        </button>
                        <button
                            type="button"
                            className="inline-flex items-center rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            data-testid="continuation-cancel"
                            disabled={state.kind === "creating"}
                            onClick={() => {
                                // A new attempt from here is a new fork, so the
                                // key is dropped rather than kept.
                                idempotencyKeyRef.current = null;
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
