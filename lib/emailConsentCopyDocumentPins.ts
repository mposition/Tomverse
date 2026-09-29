/**
 * The document-level pins over the approved consent wording.
 *
 * Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
 *
 * ## What these are for, now that something else compares the bytes
 *
 * They are an **in-tree consistency pin**, and nothing more. The base comparison
 * (`scripts/check-consent-copy-immutability.mjs`) is what says an approved
 * version's bytes have not changed since the base revision; it reads the document
 * and the version records directly and does not read this file at all.
 *
 * An earlier version of that check did read these, and this comment said so. It
 * also described a `DOCUMENT_AMENDMENTS` list that no longer exists. Both were
 * true of a design that compared digests; the check compares the document section
 * by section now, so a digest recorded here proves nothing to it. A comment that
 * describes a mechanism the code has dropped is worse than no comment, because
 * the next person reads it as the design.
 *
 * What they still do, which the base comparison does not:
 *
 * - They fail in the unit suite the moment the document changes, without needing
 *   a base revision at all -- so a local edit is caught before it is pushed.
 * - They make an intended change a **recorded** act: repinning is a line in the
 *   diff that says the document moved, next to the change that moved it.
 * - They hold the partition honest. `tests/emailConsentCopy.test.mjs` reassembles
 *   the document from the parts these cover and compares it with the file, which
 *   is what keeps "every byte belongs to exactly one section" true of the same
 *   partition the base comparison uses.
 *
 * Nothing here is used at runtime. It is a record, read by one test.
 */

/**
 * Every byte of the approved document, as one digest.
 *
 * Moves whenever a version is added, legitimately, which is the whole reason the
 * other pins exist. Not a claim that the owner approved every byte: the approval
 * covers sections 1 to 6 and says so.
 */
export const APPROVED_DOCUMENT_DIGEST = "c78200d4c8a44dbcc24166e9185da2b6";

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
export const UNVERSIONED_SECTIONS_DIGEST = "7400a248b8e85f4bd37a811e0223df71";
