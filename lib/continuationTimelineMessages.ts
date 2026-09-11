import type { Message } from "@/components/chat/types";

type SourceMessage = {
    id: string;
    role: string;
    ordinal: number;
    content: string;
    sourceModelLabel: string | null;
    sourceTimestamp: string | null;
    truncated: boolean;
};

/**
 * The prefix an imported message's id carries in the timeline.
 *
 * Namespaced because these ids share a React list with `Message` rows from
 * this conversation, and an `ExternalMessage` id colliding with a `Message`
 * id would silently reuse the wrong element's state. It also makes the two
 * kinds tellable apart anywhere an id is all that is at hand -- a scroll
 * anchor, a test, a log line -- without anyone having to look up which table
 * it came from.
 */
export const IMPORTED_MESSAGE_ID_PREFIX = "imported:";

/**
 * Turns one page of an imported transcript into timeline messages.
 *
 * A *view model*, and only that. Nothing here is written anywhere: the
 * snapshot stays immutable and outside this conversation's storage
 * (docs/policy/external-conversation-continuation.md §4), the seed the next
 * turn carries is built server-side from the snapshot rather than from what
 * is on screen, and the serializers in lib/chatMessageSerialization.ts are
 * allowlists, so a message carrying `imported` cannot ride a request body,
 * a stored transcript or localStorage.
 *
 * Roles are narrowed rather than trusted: `ExternalMessage.role` is whatever
 * the export said, and the chat renderer has exactly two shapes. Anything
 * that is not "user" is drawn as the other side of the conversation, which is
 * what every adapter's non-user role means.
 */
export function continuationTimelineMessages(
    messages: readonly SourceMessage[],
    provider: string
): Message[] {
    return messages.map((message) => ({
        id: `${IMPORTED_MESSAGE_ID_PREFIX}${message.id}`,
        role: message.role === "user" ? "user" : "assistant",
        content: message.content,
        // Not "pending", "error" or "cancelled": an imported turn is a
        // finished turn, and every affordance the renderer attaches to those
        // states (retry, regenerate, report) is one this transcript must not
        // offer.
        status: "normal",
        createdAt: message.sourceTimestamp ?? undefined,
        imported: {
            provider,
            sourceModelLabel: message.sourceModelLabel,
            truncated: message.truncated,
        },
    }));
}
