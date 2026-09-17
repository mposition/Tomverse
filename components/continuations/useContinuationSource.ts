"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { IMPORTED_MESSAGE_ID_PREFIX } from "@/lib/continuationTimelineMessages";
import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The imported half of a continued conversation, as data for the timeline.
 *
 * Policy: docs/policy/external-conversation-continuation.md §5.1, §8.2.
 *
 * ## Why this is a hook and not a component any more
 *
 * The imported transcript used to be drawn by a component of its own, above
 * the panel row: its own heading, its own disclosure, its own capped scroller.
 * That made it a second conversation on the page -- two scroll areas, two
 * reading orders, and a transcript the user had to press a control to see, on
 * a screen whose entire purpose was that transcript. What it actually is, is
 * the earlier part of this conversation. So it is loaded here and rendered by
 * `ChatMessageList` as ordinary messages, in the one scroll container the
 * chat has always had.
 *
 * ## Ownership and staleness
 *
 * Read per conversation, and every response is checked against the request
 * that is current when it lands. A generation counter rather than only a
 * cleanup flag: the same mount is reused across conversation switches (the
 * workspace selects in place), so "did this component unmount" is the wrong
 * question -- the right one is "is this still the conversation that asked".
 * A `AbortController` cancels the request itself so a slow bridge read does
 * not hold a connection open for a screen nobody is on.
 */

export type ContinuationSourceMessage = {
    id: string;
    role: string;
    ordinal: number;
    content: string;
    sourceModelLabel: string | null;
    sourceTimestamp: string | null;
    truncated: boolean;
};

export type ContinuationTimeline = {
    conversationId: string;
    provider: string;
    importedAt: string;
    seed: {
        messageCount: number;
        truncatedMessageCount: number;
        omittedMessageCount: number;
    };
    source:
        | {
              status: "available";
              title: string;
              messageTotal: number;
              offset: number;
              limit: number;
              messages: ContinuationSourceMessage[];
          }
        | { status: "deleted"; deletedAt: string | null }
        | { status: "locked" };
    /** Only on a read that asked for a message by id. */
    focus?: { found: boolean };
};

/**
 * A request to open the transcript at one imported message (a search hit).
 * `nonce` distinguishes two requests for the same message, so a second click
 * on the same hit scrolls again.
 */
export type ContinuationFocusRequest = {
    externalMessageId: string;
    nonce: number;
};

/** How a focus request ended, once it has. */
export type ContinuationFocusOutcome = {
    nonce: number;
    /** `imported:<id>` when the message is on screen, otherwise null. */
    messageId: string | null;
    /** Why it is not: the id did not resolve, the source is locked or gone, or the read failed. */
    reason: "found" | "not_found" | "locked" | "deleted" | "failed";
};

/** One page of imported turns. */
export const CONTINUATION_SOURCE_PAGE_SIZE = 100;

export type ContinuationSource = {
    /** `null` until the first read lands, and for a conversation with no bridge. */
    timeline: ContinuationTimeline | null;
    /** Whether an older page is on its way. */
    loadingMore: boolean;
    /** Whether there are older imported turns still to fetch. */
    hasMore: boolean;
    /** Fetches the page of older turns immediately above what is held. */
    loadMore: () => void;
    /** How many imported turns are still above the loaded window. */
    olderCount: number;
    /** Whether a newer page is on its way. */
    loadingNewer: boolean;
    /** Fetches the page of newer turns immediately below what is held. */
    loadNewer: () => void;
    /**
     * How many imported turns are still below the loaded window. Zero except
     * after opening at a search hit, which starts the window mid-transcript.
     */
    newerCount: number;
    /** The outcome of the latest focus request, once it has one. */
    focusOutcome: ContinuationFocusOutcome | null;
};

export function useContinuationSource(
    conversationId: string | null,
    focus: ContinuationFocusRequest | null = null,
    /**
     * Called once per focus request, when it settles. The caller consumes the
     * request here; dropping it afterwards does not re-read the transcript.
     */
    onFocusSettled?: (outcome: ContinuationFocusOutcome) => void
): ContinuationSource {
    /*
      Held with the conversation it belongs to, and read back by comparison.

      The obvious shape -- a bare `timeline` cleared at the top of the effect
      -- sets state synchronously during an effect, which costs a cascading
      render on every conversation switch and is what
      `react-hooks/set-state-in-effect` is about. Storing the owner alongside
      the value makes "this belongs to the conversation that is no longer
      open" a *derivation* instead: nothing has to be cleared, because
      nothing stale can be read.
    */
    const [loaded, setLoaded] = useState<{
        conversationId: string;
        timeline: ContinuationTimeline;
    } | null>(null);
    const timeline =
        loaded && loaded.conversationId === conversationId ? loaded.timeline : null;
    /** Which conversation has an older page in flight, for the same reason. */
    // Each holds the request that set it, and only that request clears it: a
    // read superseded by a newer generation (a new focus, a switch) must not
    // leave the control disabled forever, nor clear a newer request's state.
    const [pendingOlderFor, setPendingOlderFor] = useState<{ conversationId: string } | null>(null);
    const loadingMore = pendingOlderFor?.conversationId === conversationId;
    const [pendingNewerFor, setPendingNewerFor] = useState<{ conversationId: string } | null>(null);
    const loadingNewer = pendingNewerFor?.conversationId === conversationId;
    // Owned like `loaded`: an outcome for the conversation that is no longer
    // open is not one this screen may act on.
    const [focusState, setFocusState] = useState<{
        conversationId: string;
        outcome: ContinuationFocusOutcome;
    } | null>(null);
    const focusOutcome =
        focusState && focusState.conversationId === conversationId ? focusState.outcome : null;
    const onFocusSettledRef = useRef(onFocusSettled);
    useEffect(() => {
        onFocusSettledRef.current = onFocusSettled;
    }, [onFocusSettled]);
    /*
      The conversation the held timeline was last read for. A focus request
      that is consumed turns `focus` back to null for the same conversation,
      and that must not re-read it at the end -- the reader is looking at the
      hit. Reset whenever no conversation is open, so leaving and coming back
      reads it afresh from the end.
    */
    const lastReadConversationRef = useRef<string | null>(null);
    const focusMessageId = focus?.externalMessageId ?? null;
    const focusNonce = focus?.nonce ?? null;
    /*
      Which read is current. Incremented on every conversation change, and
      every response compares against it before writing state -- so a bridge
      read for the conversation the user has just left cannot land on top of
      the one they are looking at now.
    */
    const generationRef = useRef(0);

    useEffect(() => {
        if (!conversationId) {
            generationRef.current += 1;
            lastReadConversationRef.current = null;
            return;
        }
        if (focusNonce === null && lastReadConversationRef.current === conversationId) return;
        generationRef.current += 1;
        const generation = generationRef.current;
        lastReadConversationRef.current = conversationId;

        const controller = new AbortController();
        const settleFocus = (reason: ContinuationFocusOutcome["reason"]) => {
            if (focusNonce === null || generationRef.current !== generation) return;
            setFocusState({
                conversationId,
                outcome: {
                    nonce: focusNonce,
                    messageId:
                        reason === "found" && focusMessageId
                            ? `${IMPORTED_MESSAGE_ID_PREFIX}${focusMessageId}`
                            : null,
                    reason,
                },
            });
            onFocusSettledRef.current?.({
                nonce: focusNonce,
                messageId:
                    reason === "found" && focusMessageId
                        ? `${IMPORTED_MESSAGE_ID_PREFIX}${focusMessageId}`
                        : null,
                reason,
            });
        };
        void (async () => {
            try {
                // `offset=end`: the page that has to arrive first is the one
                // next to the divider. Older turns are fetched backwards from
                // there, so the transcript grows upward the way a chat
                // history does rather than downward into the answers.
                // A search hit instead asks for the page around its message,
                // and the window then grows in both directions.
                const position = focusMessageId
                    ? `around=${encodeURIComponent(focusMessageId)}`
                    : "offset=end";
                const response = await fetch(
                    `/api/conversations/${encodeURIComponent(conversationId)}/continuation?${position}&limit=${CONTINUATION_SOURCE_PAGE_SIZE}`,
                    { cache: "no-store", signal: controller.signal }
                );
                if (!response.ok) {
                    // A conversation with no bridge answers 404, which is not
                    // an error to announce: it means there is no imported
                    // half, so there is nothing to draw.
                    await discardResponseBody(response);
                    settleFocus("failed");
                    return;
                }
                const page = (await response.json()) as ContinuationTimeline;
                if (generationRef.current === generation) {
                    setLoaded({ conversationId, timeline: page });
                    settleFocus(
                        page.source.status === "locked"
                            ? "locked"
                            : page.source.status === "deleted"
                              ? "deleted"
                              : page.focus?.found
                                ? "found"
                                : "not_found"
                    );
                }
            } catch (error) {
                if (!(error instanceof DOMException && error.name === "AbortError")) {
                    settleFocus("failed");
                }
                // Same answer as a 404, and an aborted read is not a failure.
                // The Tomverse conversation is readable either way, and a
                // banner about a failed provenance read would be noise on a
                // screen that is working.
            }
        })();

        return () => controller.abort();
        // The nonce, not only the id: pressing the same hit again is a new
        // request to be taken there.
    }, [conversationId, focusMessageId, focusNonce]);

    const loadMore = useCallback(() => {
        if (!conversationId) return;
        if (!timeline || timeline.source.status !== "available") return;
        if (loadingMore) return;
        // Backwards from what is held. `offset` is the server's own resolved
        // offset for the oldest loaded turn, so nothing here has to guess
        // where the window sits in a transcript it has only seen part of.
        const windowStart = timeline.source.offset;
        if (windowStart <= 0) return;
        const nextOffset = Math.max(0, windowStart - CONTINUATION_SOURCE_PAGE_SIZE);
        // Exactly the gap, so a page cannot overlap what is already held and
        // put the same turn on screen twice.
        const nextLimit = windowStart - nextOffset;
        const generation = generationRef.current;
        const owner = conversationId;
        const token = { conversationId: owner };
        setPendingOlderFor(token);
        void (async () => {
            try {
                const response = await fetch(
                    `/api/conversations/${encodeURIComponent(conversationId)}/continuation?offset=${nextOffset}&limit=${nextLimit}`,
                    { cache: "no-store" }
                );
                if (!response.ok) {
                    await discardResponseBody(response);
                    return;
                }
                const page = (await response.json()) as ContinuationTimeline;
                if (generationRef.current !== generation) return;
                if (page.source.status !== "available") {
                    // The snapshot was deleted or locked between the two
                    // reads. The newer answer wins: it is what the next turn
                    // will carry.
                    setLoaded({ conversationId: owner, timeline: page });
                    return;
                }
                const older = page.source;
                setLoaded((current) =>
                    current &&
                    current.conversationId === owner &&
                    current.timeline.source.status === "available"
                        ? {
                              conversationId: owner,
                              timeline: {
                                  ...current.timeline,
                                  source: {
                                      ...current.timeline.source,
                                      // The window now starts where the older
                                      // page does, which is what the next
                                      // press reads.
                                      offset: older.offset,
                                      messages: [
                                          ...older.messages,
                                          ...current.timeline.source.messages,
                                      ],
                                  },
                              },
                          }
                        : { conversationId: owner, timeline: page }
                );
            } catch {
                // The transcript is read-only; nothing is lost by not growing it.
            } finally {
                setPendingOlderFor((current) => (current === token ? null : current));
            }
        })();
    }, [conversationId, loadingMore, timeline]);

    const loadNewer = useCallback(() => {
        if (!conversationId) return;
        if (!timeline || timeline.source.status !== "available") return;
        if (loadingNewer) return;
        const windowEnd = timeline.source.offset + timeline.source.messages.length;
        const remaining = timeline.source.messageTotal - windowEnd;
        if (remaining <= 0) return;
        const generation = generationRef.current;
        const owner = conversationId;
        const token = { conversationId: owner };
        setPendingNewerFor(token);
        void (async () => {
            try {
                const response = await fetch(
                    `/api/conversations/${encodeURIComponent(conversationId)}/continuation?offset=${windowEnd}&limit=${Math.min(CONTINUATION_SOURCE_PAGE_SIZE, remaining)}`,
                    { cache: "no-store" }
                );
                if (!response.ok) {
                    await discardResponseBody(response);
                    return;
                }
                const page = (await response.json()) as ContinuationTimeline;
                if (generationRef.current !== generation) return;
                if (page.source.status !== "available") {
                    setLoaded({ conversationId: owner, timeline: page });
                    return;
                }
                const newer = page.source;
                setLoaded((current) =>
                    current &&
                    current.conversationId === owner &&
                    current.timeline.source.status === "available" &&
                    // Only if the window has not moved since this was asked:
                    // a page that does not start where the window ends would
                    // leave a gap or a duplicate.
                    current.timeline.source.offset + current.timeline.source.messages.length ===
                        newer.offset
                        ? {
                              conversationId: owner,
                              timeline: {
                                  ...current.timeline,
                                  source: {
                                      ...current.timeline.source,
                                      messages: [
                                          ...current.timeline.source.messages,
                                          ...newer.messages,
                                      ],
                                  },
                              },
                          }
                        : current
                );
            } catch {
                // Read-only; nothing is lost by not growing it.
            } finally {
                setPendingNewerFor((current) => (current === token ? null : current));
            }
        })();
    }, [conversationId, loadingNewer, timeline]);

    const hasMore =
        timeline?.source.status === "available" && timeline.source.offset > 0;

    return {
        timeline,
        loadingMore,
        hasMore: Boolean(hasMore),
        loadMore,
        /** How many imported turns are still above the loaded window. */
        olderCount:
            timeline?.source.status === "available" ? timeline.source.offset : 0,
        loadingNewer,
        loadNewer,
        newerCount:
            timeline?.source.status === "available"
                ? Math.max(
                      0,
                      timeline.source.messageTotal -
                          (timeline.source.offset + timeline.source.messages.length)
                  )
                : 0,
        focusOutcome,
    };
}
