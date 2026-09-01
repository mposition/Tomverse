"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useLanguage } from "@/components/LanguageProvider";
import { continuationPath } from "@/lib/continuationRoutes";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * Starting a continuation, in one place.
 *
 * Policy: docs/policy/external-conversation-continuation.md §3, §5, §8.
 *
 * ## Why a hook rather than two call sites
 *
 * There are now two surfaces that create a continuation -- the disclosure card
 * on the source's own page, and the quick action in the imported-conversation
 * list -- and only one of them is allowed to be wrong about idempotency. The
 * key contract below is not obvious from reading either component, and it was
 * already got wrong once: the card re-minted its key on every retry, so a POST
 * that had stored a conversation and only lost its response produced a second
 * one on the next press. Copying that logic into a second component is how the
 * same defect comes back on a surface nobody re-checked.
 *
 * So the components own their own presentation -- a disclosure and two buttons
 * on one, a single button on the other -- and neither owns the key.
 *
 * ## The key contract
 *
 * The key identifies *this attempt*, not this click and not this component.
 *
 *   - Minted when the launcher is holding none, which is what makes a retry a
 *     retry: a double click, a dropped response and a "try again" all send the
 *     same key, and the server resolves them to the one conversation the first
 *     request created.
 *   - Cleared only by `cancel()`. Arming again after an explicit cancel is a
 *     second, deliberate fork, which §3 allows.
 *   - Never cleared by a failure. That is the case the whole thing exists for.
 *
 * The server decides everything else: `createExternalContinuation` reads by
 * `(userId, idempotencyKey)`, creates, and re-reads on a unique violation, so
 * two presses carrying the same key can only ever yield one conversation.
 */

export type ContinuationLauncherStatus = "idle" | "creating" | "failed";

export type ContinuationLauncher = {
    status: ContinuationLauncherStatus;
    /** Set only while `status` is "failed". */
    errorMessage: string | null;
    /**
     * Mints a key if there is none, then posts. Navigates on success.
     *
     * Resolves `true` only when a conversation was reached. Callers need the
     * answer rather than the status field because the status they captured is
     * from the render that started the attempt; the card uses it to collapse
     * its disclosure back to a retry button.
     */
    start: () => Promise<boolean>;
    /** The one thing that drops the key: an explicit "no, start over". */
    cancel: () => void;
};

export function useContinuationLauncher({
    externalConversationId,
}: {
    externalConversationId: string;
}): ContinuationLauncher {
    const { t } = useLanguage();
    const router = useRouter();
    const [status, setStatus] = useState<ContinuationLauncherStatus>("idle");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const idempotencyKeyRef = useRef<string | null>(null);

    const start = useCallback(async (): Promise<boolean> => {
        // Guards the double click at the source: the second press finds the
        // launcher already creating and returns before it can send anything.
        // The button is disabled too, but a disabled attribute is a rendering
        // detail and this is the invariant.
        if (status === "creating") return false;

        // `crypto.randomUUID` exists in every browser this application
        // supports; the fallback keeps a non-secure context (an http://
        // preview) failing by creating one conversation rather than by
        // throwing before the click does anything.
        idempotencyKeyRef.current ??=
            typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const idempotencyKey = idempotencyKeyRef.current;

        setStatus("creating");
        setErrorMessage(null);
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
                setStatus("failed");
                setErrorMessage(refusalMessage(response.status, t));
                return false;
            }
            const body = (await response.json()) as { conversationId?: string };
            if (!body.conversationId) {
                setStatus("failed");
                setErrorMessage(t("continuation.createFailed"));
                return false;
            }
            router.push(continuationPath(body.conversationId));
            return true;
        } catch {
            // The attempt keeps its key, so pressing again resolves to
            // whatever the first request created rather than making a second
            // conversation.
            setStatus("failed");
            setErrorMessage(t("continuation.createFailed"));
            return false;
        }
    }, [externalConversationId, router, status, t]);

    const cancel = useCallback(() => {
        idempotencyKeyRef.current = null;
        setStatus("idle");
        setErrorMessage(null);
    }, []);

    return { status, errorMessage, start, cancel };
}

/**
 * What each refusal is allowed to say.
 *
 * Three of the four are not "try again", and saying so would send the owner
 * round a loop that cannot end:
 *
 *   403  the rollout flag is off (§7). Not available, and no retry helps.
 *   404  not theirs, or gone. The same answer either way, on purpose: the
 *        service scopes by `userId`, so "missing" and "somebody else's" are
 *        one outcome and nothing here may distinguish them (§10).
 *   423  the snapshot is locked (§6). The remedy is the password, on the
 *        source's own page -- not another press of this button.
 *   409  a conflict the server already resolves by reading the winner back,
 *        so reaching here means something else. Generic, and retryable.
 */
const refusalMessage = (status: number, t: (key: string) => string): string => {
    if (status === 403) return t("continuation.unavailable");
    if (status === 404) return t("continuation.sourceUnavailable");
    if (status === 423) return t("continuation.lockedRefusal");
    return t("continuation.createFailed");
};
