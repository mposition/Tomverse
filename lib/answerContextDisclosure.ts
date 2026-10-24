/**
 * What an answer says about the profile knowledge it was given
 * (docs/policy/external-conversation-import-and-memory.md §14.3).
 *
 * Account memory is no longer stated per answer: the owner removed that
 * disclosure on 2026-10-24 as noise on every reply, and the memory settings
 * page remains where a user sees and deletes what is remembered.
 *
 * A count is stated only above zero. `null` means the request could not carry
 * knowledge at all and `0` means it could and nothing was selected; both would
 * be a misleading "0 used". The counts arrive from a response header via
 * Number(), so anything that is not a whole positive number is not stated
 * either -- a renderer that trusted NaN would print "NaN excerpts".
 *
 * `knowledgeChunkCount` is named for what the server can observe: excerpts
 * placed in the prompt. Whether the model drew on them is not knowable here,
 * and copy that implied it would claim more than the number supports.
 *
 * Pure, so the whole matrix is testable without a browser
 * (tests/answerContextDisclosure.test.mjs).
 */
export function knowledgeExcerptCountToShow(count: unknown): number | null {
    return typeof count === "number" && Number.isSafeInteger(count) && count > 0
        ? count
        : null;
}
