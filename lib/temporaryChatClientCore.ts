/**
 * When the browser deletes a temporary Chat (components/chat/useTemporaryChat.ts).
 *
 * Pure, so the decisions behind the "deleted when you leave" promise are
 * tested without a browser. The hook only performs what these return.
 *
 * Leaving is any of:
 *   - opening another conversation, or a new one, after the temporary one was
 *     open -- or opening another conversation while it was still being
 *     created or its first message still being saved;
 *   - the Chat screen going away: an in-app navigation that unmounts it, a
 *     reload, closing the tab (`pagehide`);
 *   - the signed-in account changing;
 *   - a newer temporary Chat being created in the same tab, which replaces an
 *     older one that was never opened.
 *
 * Each deletes through the ordinary conversation delete. A delete that cannot
 * reach the server (the account already signed out, the network gone) is
 * covered by the server, which stops it taking messages 24 hours after it
 * started and deletes it soon after -- the copy says both halves.
 */

export type TemporaryChatTracker = { owner: string; id: string; entered: boolean } | null;

export type TemporaryChatStep = {
    next: TemporaryChatTracker;
    /** The conversation to delete now, if any. */
    deleteId: string | null;
    /** Whether the toggle for the next new Chat goes back off. */
    disarm: boolean;
};

const unchanged = (tracker: TemporaryChatTracker): TemporaryChatStep => ({ next: tracker, deleteId: null, disarm: false });

/** What the open conversation (or the account) changing means for the tracked one. */
export function temporaryChatOnView(
    tracker: TemporaryChatTracker,
    view: { ownerKey: string | null; currentChatId: string | null }
): TemporaryChatStep {
    if (!tracker) return unchanged(null);
    if (tracker.owner !== view.ownerKey) return { next: null, deleteId: tracker.id, disarm: true };
    if (view.currentChatId === tracker.id) {
        return tracker.entered ? unchanged(tracker) : { next: { ...tracker, entered: true }, deleteId: null, disarm: true };
    }
    // Created but not opened yet, and the screen is still on a new chat: the
    // first message is still being saved.
    if (!tracker.entered && view.currentChatId === null) return unchanged(tracker);
    // Opened and then left, or another conversation opened before it ever was.
    return { next: null, deleteId: tracker.id, disarm: false };
}

/** The Chat screen is going away: whatever is tracked goes with it. */
export const temporaryChatOnLeave = (tracker: TemporaryChatTracker): string | null => tracker?.id ?? null;

/**
 * A create response arrived.
 *
 * It is tracked only when the person is still where they started it: on the
 * Chat screen, on a new chat. If they left the screen, or opened another
 * conversation while the request was in flight, the leave had nothing to
 * delete yet, so the conversation is deleted as soon as its id is known. A
 * newer temporary Chat replaces an older one that was never opened, and the
 * older one is deleted.
 */
export function temporaryChatOnCreated(input: {
    ownerKey: string | null;
    created: unknown;
    screenLeft: boolean;
    currentChatId: string | null;
    previous: TemporaryChatTracker;
}): { track: TemporaryChatTracker; deleteIds: string[] } {
    const record = input.created as { id?: unknown; temporary?: unknown } | null;
    if (record?.temporary !== true || typeof record.id !== "string") return { track: input.previous, deleteIds: [] };
    if (input.screenLeft || !input.ownerKey || (input.currentChatId !== null && input.currentChatId !== record.id)) {
        return { track: input.previous, deleteIds: [record.id] };
    }
    return {
        track: { owner: input.ownerKey, id: record.id, entered: false },
        deleteIds: input.previous && input.previous.id !== record.id ? [input.previous.id] : [],
    };
}
