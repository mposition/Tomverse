/**
 * Client-safe pieces of a Tomverse Chat image turn (lib/chatImageTurn.ts).
 */

/**
 * How the stored answer text of an image turn begins. The image itself is
 * shown from the group; this text is what later turns, shares and exports
 * read, so it says plainly that an image was made and for what.
 */
export const CHAT_IMAGE_TURN_CONTENT_PREFIX = "[Image generated]";

/** What a transcript message carries when it is answered by an image group. */
export type ChatImageTurnRef = { groupId: string };

/** The client's reading of a message's `imageTurn`; anything else is none. */
export const readChatImageTurnRef = (value: unknown): ChatImageTurnRef | null => {
    if (typeof value !== "object" || value === null) return null;
    const groupId = (value as { groupId?: unknown }).groupId;
    return typeof groupId === "string" && groupId ? { groupId } : null;
};

/** What the send asks the image turn for: the image-intent triage's choice. */
export type ChatImageTurnRequest = {
    modelIds: string[];
    preset: "draft" | "standard" | "final" | null;
    /**
     * Set on a retry only: the answer id the first try used, which is also
     * the image group's idempotency key, so the retry recovers that group
     * instead of reserving a second one.
     */
    assistantMessageId?: string;
};
