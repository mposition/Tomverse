/**
 * When the browser deletes a temporary Chat (components/chat/useTemporaryChat.ts).
 *
 * Pure, so the decisions behind the "deleted when you leave" promise are
 * tested without a browser. The hook only performs what these return.
 *
 * Leaving is any of:
 *   - opening another conversation, or a new one, after the temporary one was
 *     open;
 *   - the Chat screen going away: an in-app navigation that unmounts it, a
 *     reload, closing the tab (`pagehide`);
 *   - the signed-in account changing.
 *
 * Each deletes through the ordinary conversation delete. A delete that cannot
 * reach the server (the account already signed out, the network gone) is
 * covered by the server, which deletes the conversation 24 hours after it
 * started -- the copy says both halves.
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
    // Created but not opened yet: the first message is still being saved, and
    // the composer is still on the new-chat screen.
    if (!tracker.entered) return unchanged(tracker);
    return { next: null, deleteId: tracker.id, disarm: false };
}

/** The Chat screen is going away: whatever is tracked goes with it. */
export const temporaryChatOnLeave = (tracker: TemporaryChatTracker): string | null => tracker?.id ?? null;
