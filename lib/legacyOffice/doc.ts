/**
 * Text out of a Word 97-2003 `.doc`.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * The text of a `.doc` is not stored in reading order. The WordDocument
 * stream holds runs of characters wherever a save happened to put them, and a
 * *piece table* in a second stream says which byte range holds which range of
 * character positions, and whether that piece is one byte per character
 * (Windows-1252) or two (UTF-16LE). Reading the stream front to back gives
 * you the document's edit history interleaved with its text, which is why
 * "grep the strings out of it" produces the nonsense it does.
 *
 * So this walks the real structure: the FIB for the piece-table location, the
 * CLX for the pieces, then each piece in character order.
 *
 * Two things it deliberately does not do. It does not decrypt: a file whose
 * FIB says it is encrypted is refused by name, because a password prompt is
 * not something an attachment can have and a partial read of ciphertext is
 * worse than a refusal. And it never touches the macro storage: this reads
 * three streams by name and nothing else, so a VBA project is bytes nobody
 * asked about.
 */

import {
    LegacyOfficeError,
    type LegacyParseBudget,
} from "@/lib/legacyOffice/budget";
import { openCompoundFile, readCompoundStream } from "@/lib/legacyOffice/cfbf";
import { decodeCp1252Byte } from "@/lib/legacyOffice/codepage";

/** Word 97 and later. Word 6/95 wrote 0xA5DB or 0xA5DC and a different FIB. */
const WIDENT_WORD97 = 0xa5ec;

const FIB_FLAG_ENCRYPTED = 0x0100;
const FIB_FLAG_WHICH_TABLE_STREAM = 0x0200;

/** Index of fcClx/lcbClx in fibRgFcLcb97. */
const FC_LCB_CLX_INDEX = 33;
/** Index of ccpText in fibRgLw97. */
const LW_CCP_TEXT_INDEX = 3;

const CLX_PRC = 0x01;
const CLX_PCDT = 0x02;

/** Set on a piece's `fc` when the piece is one byte per character. */
const FC_COMPRESSED = 0x40000000;
const FC_MASK = 0x3fffffff;

const viewOf = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * What one Word control character becomes.
 *
 * `null` means "drop it": a picture anchor, a footnote reference and an
 * annotation mark are positions in the document, not characters of it, and
 * passing them through would put unprintable bytes in a prompt.
 */
const translateWordCharacter = (code: number): string | null => {
    switch (code) {
        case 0x0d: // paragraph
        case 0x07: // cell / row mark
        case 0x0b: // line break
        case 0x0c: // page or section break
            return "\n";
        case 0x09:
            return "\t";
        case 0x1e: // non-breaking hyphen
            return "-";
        case 0x1f: // optional hyphen
            return "";
        case 0xa0: // non-breaking space
            return " ";
        case 0x01: // inline picture
        case 0x02: // footnote or endnote reference
        case 0x03:
        case 0x04:
        case 0x05: // annotation reference
        case 0x08: // drawn object
            return null;
        default:
            return code < 0x20 ? null : String.fromCharCode(code);
    }
};

type Piece = {
    readonly characterCount: number;
    readonly byteOffset: number;
    readonly compressed: boolean;
};

/**
 * The piece table.
 *
 * A CLX is a run of optional property blocks followed by exactly one piece
 * table, so the blocks are skipped by their own declared length rather than
 * searched past -- a length-driven walk is the only one a hostile file cannot
 * steer.
 */
const readPieceTable = (clx: Uint8Array, budget: LegacyParseBudget): Piece[] => {
    const view = viewOf(clx);
    let at = 0;
    let plc: Uint8Array | null = null;

    while (at < clx.length) {
        budget.tick();
        const kind = clx[at];
        if (kind === CLX_PRC) {
            if (at + 3 > clx.length) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
            const length = view.getInt16(at + 1, true);
            if (length < 0) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
            at += 3 + length;
            continue;
        }
        if (kind === CLX_PCDT) {
            if (at + 5 > clx.length) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
            const length = view.getUint32(at + 1, true);
            const start = at + 5;
            if (length < 4 || start + length > clx.length) {
                throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
            }
            plc = clx.subarray(start, start + length);
            break;
        }
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    if (!plc) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");

    // A PlcPcd is (n + 1) character positions followed by n eight-byte
    // descriptors, so its length determines n exactly.
    const count = (plc.length - 4) / 12;
    if (!Number.isInteger(count) || count <= 0) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    const plcView = viewOf(plc);
    const descriptorsAt = (count + 1) * 4;
    const pieces: Piece[] = [];
    for (let index = 0; index < count; index += 1) {
        budget.tick();
        const cpStart = plcView.getUint32(index * 4, true);
        const cpEnd = plcView.getUint32((index + 1) * 4, true);
        if (cpEnd < cpStart) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        const fc = plcView.getUint32(descriptorsAt + index * 8 + 2, true);
        const compressed = (fc & FC_COMPRESSED) !== 0;
        pieces.push({
            characterCount: cpEnd - cpStart,
            byteOffset: compressed ? (fc & FC_MASK) >>> 1 : fc & FC_MASK,
            compressed,
        });
    }
    return pieces;
};

/**
 * Extracts the main document text.
 *
 * Only the main body: `ccpText` is where it ends, and everything after it in
 * character-position order is footnotes, headers, annotations and text boxes,
 * each of which would arrive without the context that makes it mean anything.
 */
export function extractDocText(
    bytes: Uint8Array,
    budget: LegacyParseBudget
): string {
    const container = openCompoundFile(bytes, budget);
    const wordDocument = readCompoundStream(container, "WordDocument");
    if (!wordDocument || wordDocument.length < 68) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    const fib = viewOf(wordDocument);
    if (fib.getUint16(0, true) !== WIDENT_WORD97) {
        // Word 6/95 and anything else that put a compound file around a
        // different FIB. Refused rather than guessed at.
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    const flags = fib.getUint16(10, true);
    if ((flags & FIB_FLAG_ENCRYPTED) !== 0) {
        throw new LegacyOfficeError("LEGACY_OFFICE_ENCRYPTED");
    }

    // The variable-length FIB sections are walked by their own counts rather
    // than by the sizes a Word 97 file happens to use, so a later writer that
    // grew one of them still parses.
    let at = 32;
    const csw = fib.getUint16(at, true);
    at += 2 + csw * 2;
    if (at + 2 > wordDocument.length) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }
    const cslw = fib.getUint16(at, true);
    const fibRgLwAt = at + 2;
    at = fibRgLwAt + cslw * 4;
    if (at + 2 > wordDocument.length || cslw <= LW_CCP_TEXT_INDEX) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }
    const cbRgFcLcb = fib.getUint16(at, true);
    const fibRgFcLcbAt = at + 2;
    if (cbRgFcLcb <= FC_LCB_CLX_INDEX) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    const ccpText = fib.getUint32(fibRgLwAt + LW_CCP_TEXT_INDEX * 4, true);
    const clxAt = fibRgFcLcbAt + FC_LCB_CLX_INDEX * 8;
    if (clxAt + 8 > wordDocument.length) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }
    const fcClx = fib.getUint32(clxAt, true);
    const lcbClx = fib.getUint32(clxAt + 4, true);
    if (lcbClx === 0) throw new LegacyOfficeError("LEGACY_OFFICE_NO_TEXT");

    // Which of the two table streams is live is a bit in the FIB. Reading the
    // wrong one yields a piece table from a previous save.
    const tableName = (flags & FIB_FLAG_WHICH_TABLE_STREAM) !== 0 ? "1Table" : "0Table";
    const table = readCompoundStream(container, tableName);
    if (!table || fcClx + lcbClx > table.length) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    const pieces = readPieceTable(table.subarray(fcClx, fcClx + lcbClx), budget);

    let out = "";
    let charactersTaken = 0;
    // Field instructions -- the `HYPERLINK "http://..."` half of a field --
    // sit between 0x13 and 0x14 and are not what the document says. The
    // result, between 0x14 and 0x15, is.
    let inFieldInstruction = 0;

    for (const piece of pieces) {
        if (charactersTaken >= ccpText) break;
        budget.tick();

        const take = Math.min(piece.characterCount, ccpText - charactersTaken);
        const width = piece.compressed ? 1 : 2;
        const start = piece.byteOffset;
        const end = start + take * width;
        if (start < 0 || end > wordDocument.length) {
            throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        }
        budget.claimBytes(end - start);

        for (let index = 0; index < take; index += 1) {
            if ((index & 0x3ff) === 0) budget.tick();
            const code = piece.compressed
                ? decodeCp1252Byte(wordDocument[start + index])
                : wordDocument[start + index * 2] |
                  (wordDocument[start + index * 2 + 1] << 8);

            if (code === 0x13) {
                inFieldInstruction += 1;
                continue;
            }
            if (code === 0x14) {
                if (inFieldInstruction > 0) inFieldInstruction -= 1;
                continue;
            }
            if (code === 0x15) continue;
            if (inFieldInstruction > 0) continue;

            const character = translateWordCharacter(code);
            if (character === null || character === "") continue;
            if (budget.charactersRemaining() <= 0) {
                charactersTaken = ccpText;
                break;
            }
            budget.claimCharacters(character.length);
            out += character;
        }

        charactersTaken += take;
    }

    return out;
}
