/**
 * What a bridged conversation may be shared as, and what its export must say.
 *
 * Policy: docs/policy/external-conversation-continuation.md §9.
 *
 * ## Why sharing is refused rather than filtered
 *
 * A continuation's screen is two halves: an imported transcript from another
 * service, and the Tomverse turns that follow it. The share snapshot carries
 * `Message` rows, so publishing one would publish the second half only — and
 * the recipient would read answers that plainly refer to a conversation they
 * cannot see, with nothing on the page to say a first half exists.
 *
 * The alternative is worse. Including the imported half would publish a
 * transcript the user exported from a third-party account, which may contain
 * other people's messages and was imported under a promise
 * (docs/policy/external-conversation-import-and-memory.md §16) that it stays
 * account-private. That is not a default anybody should get by
 * pressing "share".
 *
 * So the MVP refuses, out loud, with a reason. It is a smaller feature and a
 * reversible one: the day a share format can carry provenance for both halves,
 * this function is where it changes.
 *
 * ## Why one function and not a check in each place
 *
 * The route and the UI must agree. `lib/billingPromotionAdminPolicy.ts` earned
 * this shape the hard way — a matrix copied into a route and a panel drifts,
 * and the drift shows up as a control the screen offers and the server
 * refuses. Both call this.
 *
 * Pure: it takes facts, not a request.
 */

export const CONTINUATION_SHARE_REFUSAL_CODE =
    "CONTINUATION_SHARE_NOT_SUPPORTED" as const;

export type ContinuationShareRefusal = {
    code: typeof CONTINUATION_SHARE_REFUSAL_CODE;
    status: 409;
    message: string;
};

/**
 * Whether this conversation may be published, given whether it continues an
 * imported source.
 *
 * Takes the fact rather than the row so the caller cannot pass "a bridge that
 * lost its source" and get a different answer: a continuation whose original
 * was deleted is still a conversation whose visible answers were shaped by an
 * excerpt the reader cannot see.
 */
export const continuationShareRefusal = (input: {
    hasContinuationBridge: boolean;
}): ContinuationShareRefusal | null =>
    input.hasContinuationBridge
        ? {
              code: CONTINUATION_SHARE_REFUSAL_CODE,
              status: 409,
              message:
                  "This conversation was started from an imported chat and cannot be shared publicly yet.",
          }
        : null;

/**
 * The provenance block a bridged conversation's export carries.
 *
 * English, and unconditionally in English, for the reason
 * `lib/memorySharingNotice.ts` gives: an export document has no reader locale
 * and its header is already English.
 *
 * Two things it must say and one it must not. It says which service the
 * original came from and when it was imported, so a reader of the file knows
 * these answers had context they cannot see; and it says the original is a
 * separate export, so nobody concludes it was lost. It does not reproduce a
 * single imported message — copying the transcript into an ordinary
 * conversation export is the silent widening
 * docs/policy/external-conversation-continuation.md §9 forbids, and it would
 * put third-party content into a file the user may forward anywhere.
 */
export const continuationExportProvenance = (input: {
    providerLabel: string;
    importedAt: Date | string;
    sourceDeleted: boolean;
}): string[] => {
    const importedAt =
        input.importedAt instanceof Date
            ? input.importedAt.toISOString()
            : input.importedAt;
    return [
        `Continued from an imported ${input.providerLabel} conversation (imported ${importedAt}).`,
        input.sourceDeleted
            ? "The imported original has since been deleted from this account."
            : "The imported original is not included here: it is stored separately and is downloaded from the imported-data export.",
        "Only the Tomverse turns below were produced by Tomverse.",
    ];
};
