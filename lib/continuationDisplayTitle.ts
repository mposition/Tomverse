/**
 * What a continued conversation is called on screen.
 *
 * Policy: docs/policy/external-conversation-continuation.md §3, §8.2.
 *
 * ## Why the source's title is not stored on the row
 *
 * §3 keeps the source's own words out of every table the source's deletion
 * does not reach, and `Conversation.title` is one of those: deleting an
 * imported snapshot leaves the continuation and its Tomverse messages
 * standing, by design, so a title copied into that row at creation would
 * outlive the deletion request that was supposed to remove it.
 *
 * So the title is resolved when it is displayed, from the snapshot itself.
 * When the snapshot goes, the name goes with it and the row falls back to a
 * translated placeholder -- which is the deletion contract doing its job
 * rather than a gap in the UI.
 *
 * ## Why only the legacy placeholder is replaced
 *
 * A stored title is either something the owner typed or the constant below,
 * and the two are not distinguishable after the fact by anything except being
 * equal to it. So the substitution is exact-match only: anything else is
 * treated as the owner's and shown unchanged, including a title that merely
 * resembles the placeholder. Getting that wrong in the other direction would
 * silently rename conversations people had named themselves.
 */

/**
 * The title `createExternalContinuation` writes.
 *
 * Never shown: it exists so a row has a non-empty title before anyone has
 * named it, and every display path replaces it. Kept in English and kept
 * exact, because equality with this string is the whole provenance signal.
 */
export const LEGACY_CONTINUATION_TITLE = "Continued from an imported chat";

export function continuationDisplayTitle({
    storedTitle,
    sourceTitle,
    fallback,
}: {
    /** `Conversation.title` as stored. */
    storedTitle: string;
    /**
     * The imported conversation's own title, when the server could read it.
     *
     * Absent when the source was deleted, when it is locked, or when this row
     * has no bridge at all -- three different facts with the same answer here.
     */
    sourceTitle?: string | null;
    /** A translated placeholder, for a row with neither a name nor a source. */
    fallback: string;
}): string {
    if (storedTitle !== LEGACY_CONTINUATION_TITLE) return storedTitle;
    const source = sourceTitle?.trim();
    return source ? source : fallback;
}
