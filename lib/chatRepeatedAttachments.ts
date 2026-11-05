/**
 * One stored file, handled once per `/api/chat` request.
 *
 * A retry keeps the failed turn in the transcript and appends a new user message
 * carrying the same attachment references, so the same file can arrive on
 * several messages. Trace 5859a17f-8b27-415a-9a4f-4bd3f7f08a20, 2026-10-08: the
 * route refused every such request, and because the copies stay in the tab's
 * transcript, every later send from that tab was refused as well.
 *
 * The copies are the same file, so the provider should receive it once and the
 * reservation should price it once. This runs before anything reads the
 * transcript, which is what makes those two agree.
 */

export type AttachmentIdentitySource = {
    attachmentId?: unknown;
    uploadId?: unknown;
    objectKey?: unknown;
};

/** How one attachment reference is keyed while a turn is being resolved. */
export const attachmentReferenceKey = (
    attachment: AttachmentIdentitySource
): string | null => {
    if (typeof attachment?.attachmentId === "string" && attachment.attachmentId) {
        return `a:${attachment.attachmentId}`;
    }
    if (typeof attachment?.uploadId === "string" && attachment.uploadId) {
        return `u:${attachment.uploadId}`;
    }
    return null;
};

/**
 * The name a request gives one file: its opaque reference, or for a guest the
 * key, which is the only name a guest object has.
 */
export const attachmentIdentity = (
    attachment: AttachmentIdentitySource
): string | null =>
    attachmentReferenceKey(attachment) ??
    (typeof attachment?.objectKey === "string"
        ? `k:${attachment.objectKey}`
        : null);

/**
 * Stands in for the text of an attachment-only question whose file moved to a
 * later copy of that question. Providers refuse an empty user message, and
 * removing the message would leave its reply first in the transcript. Not the
 * file name: docs/policy/user-attachment-persistence.md section 4.
 */
export const REPEATED_ATTACHMENT_TURN_TEXT =
    "(The file attached here is included with a later message.)";

type TranscriptMessage = {
    role: string;
    content: string;
    attachments?: unknown[];
};

/**
 * Keeps each file on the last user message naming it and removes it from the
 * earlier ones.
 *
 * The last copy, because that is the turn being answered: its files are the ones
 * the turn's handles, its source check and its "current turn" refusal all read.
 *
 * Four rules:
 *
 *  * **A transcript with nothing to collapse is returned unchanged** -- the same
 *    array, so an ordinary request and its durable digest do not move.
 *  * **A request the attachment gate must refuse is returned unchanged.** A file
 *    named twice on one message, or an inline copy anywhere, is refused by that
 *    gate; collapsing first could remove the evidence.
 *  * **Only user messages are touched.** A repeat on an assistant message is left
 *    for the gate as well: the route does not read those attachments, so moving
 *    a file to one would drop it from the prompt without anyone saying so.
 *  * **Nothing is looked up here.** Every file still goes through the ownership,
 *    size and text checks on the copy that remains, and an identical identity
 *    means the removed copy could not have answered differently.
 */
export function collapseRepeatedAttachments<T extends TranscriptMessage>(
    messages: T[]
): { messages: T[]; removedReferenceCount: number } {
    for (const message of messages) {
        const attachments = (message.attachments ?? []) as AttachmentIdentitySource[];
        const named = new Set<string>();
        for (const attachment of attachments) {
            if (typeof (attachment as { data?: unknown })?.data === "string") {
                return { messages, removedReferenceCount: 0 };
            }
            const identity = attachmentIdentity(attachment);
            if (!identity) continue;
            if (named.has(identity)) {
                return { messages, removedReferenceCount: 0 };
            }
            named.add(identity);
        }
    }

    const namedLater = new Set<string>();
    let removedReferenceCount = 0;
    const collapsed = [...messages];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "user" || !message.attachments?.length) continue;
        const attachments = message.attachments as AttachmentIdentitySource[];
        const kept = attachments.filter((attachment) => {
            const identity = attachmentIdentity(attachment);
            return !identity || !namedLater.has(identity);
        });
        for (const attachment of attachments) {
            const identity = attachmentIdentity(attachment);
            if (identity) namedLater.add(identity);
        }
        if (kept.length === attachments.length) continue;
        removedReferenceCount += attachments.length - kept.length;
        collapsed[index] = {
            ...message,
            attachments: kept,
            content:
                kept.length === 0 && !message.content.trim()
                    ? REPEATED_ATTACHMENT_TURN_TEXT
                    : message.content,
        };
    }
    return removedReferenceCount > 0
        ? { messages: collapsed, removedReferenceCount }
        : { messages, removedReferenceCount: 0 };
}
