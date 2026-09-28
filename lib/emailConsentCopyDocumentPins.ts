/**
 * The document-level pins over the approved consent wording.
 *
 * Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
 *
 * ## Why these are in `lib/` and not in the test that reads them
 *
 * Because they have to be comparable with the base revision, and a value in a
 * test file is not. A review walked round 14's finding into the one place it still
 * stood: the sections no version owns -- the status block, section 9's recorded
 * decisions, section 10's procedure -- were pinned only inside the test file, so a
 * commit could edit section 9 and repin in the same breath and the base comparison
 * saw nothing, because no version's record had moved.
 *
 * So `scripts/check-consent-copy-immutability.mjs` reads this file at the base
 * revision too. The digest here is allowed to move -- sections 9 and 10 are
 * amendable, and the document's own revision history amends them -- but only with
 * a line in `DOCUMENT_AMENDMENTS` naming the exact pair of values and what was
 * amended. An amendment nobody wrote down cannot be told from an edit to the
 * approved wording hiding behind one.
 *
 * Nothing here is used at runtime. It is a record, read by one test and one check.
 */

/**
 * Every byte of the approved document, as one digest.
 *
 * Moves whenever a version is added, legitimately, which is the whole reason the
 * other pins exist. Not a claim that the owner approved every byte: the approval
 * covers sections 1 to 6 and says so.
 */
export const APPROVED_DOCUMENT_DIGEST = "c80eacd4136aec39bbf096587989c492";

/**
 * The depth-2 sections no version owns, in document order.
 *
 * A version owns the sections its approval table names and the section holding
 * its own record. Everything else is here, and adding a version does not change
 * this list -- a new version's sections are the new version's. Which means a
 * section that no version claims fails against this list rather than passing as
 * part of the addition.
 */
export const UNVERSIONED_SECTIONS = ["0.", "7.", "9.", "10."];

/**
 * The digest over those sections plus the bytes before the first one.
 *
 * Those bytes are the title and the status block, which is where a review found
 * that 승인됨 could be changed to 반려됨 with every test still green.
 *
 * Together with each version's own two digests this covers the document exactly
 * once: the test asserts that the parts concatenate back to the source byte for
 * byte, because a partition with a gap is how three earlier attempts at this got
 * through.
 */
export const UNVERSIONED_SECTIONS_DIGEST = "9820de8da9e4b35ca56bec88d447dea1";
