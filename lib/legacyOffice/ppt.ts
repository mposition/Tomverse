/**
 * Text out of a PowerPoint 97-2003 `.ppt`.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * The presentation is a tree of records inside one stream: each node has a
 * version nibble that says whether it is a container to descend into or an
 * atom to read, and the text lives in exactly two atom types -- one holding
 * UTF-16 and one holding a single-byte page, chosen per run by whichever is
 * smaller.
 *
 * The one trap is that a deck stores its text twice. The slides carry it, and
 * so does the outline copy in `SlideListWithText`, so a reader that collects
 * every text atom hands the model each sentence twice and the model dutifully
 * summarises a document that says everything two times. The outline copy is
 * skipped for that reason, not as an optimisation.
 *
 * Pictures, embedded objects and the VBA storage are never read: this opens
 * one stream by name.
 */

import {
    LegacyOfficeError,
    type LegacyParseBudget,
} from "@/lib/legacyOffice/budget";
import { openCompoundFile, readCompoundStream } from "@/lib/legacyOffice/cfbf";
import { decodeCp1252 } from "@/lib/legacyOffice/codepage";

const RECORD_HEADER_BYTES = 8;
/** A record whose version nibble is 0xF holds other records. */
const VERSION_CONTAINER = 0x0f;

const RECORD_TEXT_CHARS_ATOM = 0x0fa0;
const RECORD_TEXT_BYTES_ATOM = 0x0fa8;
/**
 * Containers whose text is not the deck's.
 *
 * `SlideListWithText` is the outline view's copy of every slide, so reading it
 * hands the model each sentence twice. `MainMaster` and `Handout` hold the
 * template's own placeholders -- "Click to edit the title text format",
 * "Second Outline Level", the slide-number asterisk -- which are on screen in
 * PowerPoint's editor and in no printed slide. A deck of any size would
 * arrive with a page of that boilerplate ahead of its first real sentence.
 */
const SKIPPED_CONTAINERS = new Set([
    0x0ff0, // SlideListWithText
    0x03f8, // MainMaster
    0x0409, // Handout
]);
/** Present only in a presentation that was saved with a password. */
const RECORD_CRYPT_SESSION_10 = 0x2f14;

/** A deck nests a handful of levels; anything deeper is not a real document. */
const MAX_DEPTH = 24;

/** `CurrentUserAtom.headerToken` when the file is encrypted. */
const CURRENT_USER_ENCRYPTED = 0xf3d1c4df;

const utf16le = new TextDecoder("utf-16le");

/**
 * A text run worth keeping.
 *
 * Speaker notes are real content and are read, but the notes *master* -- the
 * same record type -- carries only the slide-number placeholder, which
 * PowerPoint stores as a literal asterisk. Telling the two apart structurally
 * means resolving the persist directory; telling them apart by content means
 * asking whether the run has a letter or a digit in it, which the placeholder
 * never does and a sentence always does.
 */
const carriesContent = (text: string) => /[\p{L}\p{N}]/u.test(text);

const viewOf = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * PowerPoint separates paragraphs with a carriage return and lines within one
 * with a vertical tab, and pads runs with NULs. None of the three survives
 * into a prompt as itself.
 */
const normalizeSlideText = (text: string) =>
    text
        .replace(/\r/g, "\n")
        .replace(/\v/g, "\n")
        .replace(/\u0000/g, "")
        .trimEnd();

export function extractPptText(
    bytes: Uint8Array,
    budget: LegacyParseBudget
): string {
    const container = openCompoundFile(bytes, budget);

    // The Current User stream says whether the document stream is ciphertext.
    // Checked first: every record offset after this point is meaningless if it
    // is, and walking ciphertext as a record tree is how a parser ends up
    // allocating from random numbers.
    const currentUser = readCompoundStream(container, "Current User");
    if (currentUser && currentUser.length >= 12) {
        if (viewOf(currentUser).getUint32(8, true) === CURRENT_USER_ENCRYPTED) {
            throw new LegacyOfficeError("LEGACY_OFFICE_ENCRYPTED");
        }
    }

    const stream = readCompoundStream(container, "PowerPoint Document");
    if (!stream || stream.length < RECORD_HEADER_BYTES) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    const view = viewOf(stream);
    const pieces: string[] = [];

    const walk = (start: number, end: number, depth: number) => {
        if (depth > MAX_DEPTH) return;
        let at = start;
        while (at + RECORD_HEADER_BYTES <= end) {
            budget.tick();
            const versionAndInstance = view.getUint16(at, true);
            const type = view.getUint16(at + 2, true);
            const length = view.getUint32(at + 4, true);
            const bodyStart = at + RECORD_HEADER_BYTES;
            const bodyEnd = bodyStart + length;
            // A length that runs past the parent is the end of anything this
            // reader can say about the file, not a reason to resynchronise.
            if (length < 0 || bodyEnd > end) break;

            if (type === RECORD_CRYPT_SESSION_10) {
                throw new LegacyOfficeError("LEGACY_OFFICE_ENCRYPTED");
            }

            if ((versionAndInstance & 0x0f) === VERSION_CONTAINER) {
                if (!SKIPPED_CONTAINERS.has(type)) {
                    walk(bodyStart, bodyEnd, depth + 1);
                }
            } else if (type === RECORD_TEXT_CHARS_ATOM) {
                budget.claimBytes(length);
                const text = normalizeSlideText(
                    utf16le.decode(stream.subarray(bodyStart, bodyEnd))
                );
                if (carriesContent(text)) {
                    budget.claimCharacters(text.length + 1);
                    pieces.push(text);
                }
            } else if (type === RECORD_TEXT_BYTES_ATOM) {
                budget.claimBytes(length);
                const text = normalizeSlideText(
                    decodeCp1252(stream.subarray(bodyStart, bodyEnd))
                );
                if (carriesContent(text)) {
                    budget.claimCharacters(text.length + 1);
                    pieces.push(text);
                }
            }

            at = bodyEnd;
        }
    };

    walk(0, stream.length, 0);
    return pieces.join("\n");
}
