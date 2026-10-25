"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
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
 *   - Cleared by `cancel()` -- arming again after an explicit cancel is a
 *     second, deliberate fork, which §3 allows -- and by a success this screen
 *     acted on, which ends the attempt.
 *   - Never cleared by a failure, nor by leaving the screen while the answer
 *     is unknown. That is the case the whole thing exists for, so the key is
 *     held per endpoint outside the component and outlives a remount.
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

/**
 * What the attempt continues.
 *
 * An imported snapshot (the server picks Chat or Review), or a continuation
 * being compared in Review -- a second fork of the same snapshot that the
 * server finds from that conversation's own bridge, so no external id is ever
 * sent on an account conversation URL.
 */
export type ContinuationLaunchSource =
    | { externalConversationId: string }
    | { reviewFromConversationId: string };

/**
 * The open attempt's key per endpoint, for this tab. Outside the component so
 * an attempt whose answer never reached the screen keeps its key across an
 * unmount: pressing again replays it rather than making a second conversation.
 */
const openAttemptKeys = new Map<string, string>();

const launchEndpoint = (source: ContinuationLaunchSource): string =>
    "externalConversationId" in source
        ? `/api/external-conversations/${encodeURIComponent(source.externalConversationId)}/continuations`
        : `/api/conversations/${encodeURIComponent(source.reviewFromConversationId)}/continuation/review`;

export function useContinuationLauncher(
    source: ContinuationLaunchSource,
    options: {
        /**
         * Whether the screen that pressed is still the one on show, read when
         * the answer lands. The Compare-in-Review caller moves its selection
         * before `source` follows it, and an answer in that window must not
         * navigate the conversation the user has just opened.
         */
        isOwnerCurrent?: () => boolean;
    } = {}
): ContinuationLauncher {
    const endpoint = launchEndpoint(source);
    const isOwnerCurrentRef = useRef(options.isOwnerCurrent);
    useLayoutEffect(() => {
        isOwnerCurrentRef.current = options.isOwnerCurrent;
    });
    const { t } = useLanguage();
    const router = useRouter();
    const [status, setStatus] = useState<ContinuationLauncherStatus>("idle");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    /*
      The attempt belongs to one endpoint.

      The Compare-in-Review caller keeps this hook mounted while the open
      continuation changes (`/continuations/[a]` to `[b]` is the same page),
      so the source can change under a live attempt. A key minted for A sent
      to B would be answered with A's conversation -- the server resolves by
      `(userId, key)` alone -- and A's late response would navigate B's
      screen. So the key is stored with its endpoint, the state resets when the
      endpoint changes, and a response that arrives after its endpoint stopped
      being current -- or after the launcher unmounted -- changes nothing.

      Current means "the same mount generation", not "the same endpoint
      string": A -> B -> A must not revive A's first response, so every
      endpoint change and the unmount start a new generation.
    */
    const generationRef = useRef(0);
    const [stateEndpoint, setStateEndpoint] = useState(endpoint);
    if (stateEndpoint !== endpoint) {
        setStateEndpoint(endpoint);
        setStatus("idle");
        setErrorMessage(null);
    }
    useLayoutEffect(() => {
        generationRef.current += 1;
        return () => {
            generationRef.current += 1;
        };
    }, [endpoint]);
    const creating = status === "creating" && stateEndpoint === endpoint;

    const start = useCallback(async (): Promise<boolean> => {
        // Guards the double click at the source: the second press finds the
        // launcher already creating and returns before it can send anything.
        // The button is disabled too, but a disabled attribute is a rendering
        // detail and this is the invariant.
        if (creating) return false;

        // `crypto.randomUUID` exists in every browser this application
        // supports; the fallback keeps a non-secure context (an http://
        // preview) failing by creating one conversation rather than by
        // throwing before the click does anything.
        let idempotencyKey = openAttemptKeys.get(endpoint);
        if (!idempotencyKey) {
            idempotencyKey =
                typeof crypto !== "undefined" && "randomUUID" in crypto
                    ? crypto.randomUUID()
                    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            openAttemptKeys.set(endpoint, idempotencyKey);
        }
        const generation = generationRef.current;
        const isCurrent = () =>
            generationRef.current === generation &&
            (isOwnerCurrentRef.current?.() ?? true);

        setStatus("creating");
        setErrorMessage(null);
        try {
            const response = await fetch(
                endpoint,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ idempotencyKey }),
                }
            );
            if (!isCurrent()) {
                await discardResponseBody(response);
                return false;
            }
            if (!response.ok) {
                await discardResponseBody(response);
                if (!isCurrent()) return false;
                setStatus("failed");
                setErrorMessage(refusalMessage(response.status, t));
                return false;
            }
            const body = (await response.json()) as { conversationId?: string };
            if (!isCurrent()) return false;
            if (!body.conversationId) {
                setStatus("failed");
                setErrorMessage(t("continuation.createFailed"));
                return false;
            }
            openAttemptKeys.delete(endpoint);
            router.push(continuationPath(body.conversationId));
            return true;
        } catch {
            if (!isCurrent()) return false;
            // The attempt keeps its key, so pressing again resolves to
            // whatever the first request created rather than making a second
            // conversation.
            setStatus("failed");
            setErrorMessage(t("continuation.createFailed"));
            return false;
        }
    }, [creating, endpoint, router, t]);

    const cancel = useCallback(() => {
        openAttemptKeys.delete(endpoint);
        setStatus("idle");
        setErrorMessage(null);
    }, [endpoint]);

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
