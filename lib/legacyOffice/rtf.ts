/**
 * Text out of an RTF document.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * RTF is the one legacy format that is already text, which is exactly why it
 * cannot be read as text: a two-page letter is perhaps five percent words and
 * ninety-five percent font tables, colour tables, style sheets and hex-encoded
 * pictures, and handing that to a model as a document produces an answer about
 * markup. So this is a real tokeniser: groups, control words, the destinations
 * that are metadata rather than content, and the several ways RTF spells a
 * character that is not ASCII.
 *
 * Nothing is executed and nothing is fetched. `\object` and `\pict` groups --
 * embedded OLE objects and images -- are skipped by structure, so their
 * payload is never decoded, let alone interpreted.
 */

import {
    LegacyOfficeError,
    type LegacyParseBudget,
} from "@/lib/legacyOffice/budget";
import { singleByteDecoder } from "@/lib/legacyOffice/codepage";

/**
 * Destinations whose content is not the document's text.
 *
 * `fldinst` is the interesting one: a field is stored as its instruction
 * (`HYPERLINK "http://..."`) followed by its result (the words on the page).
 * Keeping both would put a URL the reader never sees into the middle of a
 * sentence.
 */
const SKIPPED_DESTINATIONS = new Set([
    "fonttbl", "colortbl", "stylesheet", "listtable", "listoverridetable",
    "revtbl", "rsidtbl", "generator", "info", "pict", "object", "objdata",
    "objclass", "objname", "themedata", "colorschememapping", "datastore",
    "latentstyles", "xmlnstbl", "mmathpr", "fldinst", "filetbl", "upr",
    "bkmkstart", "bkmkend", "nesttableprops", "shpinst", "do", "pn", "atrfstart",
    "atrfend", "annotation", "falt", "panose", "fname", "ftncn", "ftnsep",
    "ftnsepc", "aftncn", "aftnsep", "aftnsepc", "template", "formfield",
    "datafield", "svb", "wgrffmtfilter", "userprops", "protusertbl", "password",
    "passwordhash",
]);

/** Control words that stand for a character rather than a setting. */
const LITERAL_CONTROL_WORDS: Readonly<Record<string, string>> = {
    par: "\n",
    line: "\n",
    sect: "\n",
    page: "\n",
    tab: "\t",
    cell: "\t",
    row: "\n",
    nestcell: "\t",
    nestrow: "\n",
    emdash: "—",
    endash: "–",
    emspace: " ",
    enspace: " ",
    qmspace: " ",
    bullet: "•",
    lquote: "‘",
    rquote: "’",
    ldblquote: "“",
    rdblquote: "”",
    ltrmark: "",
    rtlmark: "",
    zwj: "",
    zwnj: "",
};

type GroupState = {
    /** Characters to swallow after a `\uN`, per the enclosing `\ucN`. */
    unicodeSkip: number;
};

const isLetter = (code: number) =>
    (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);

const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

export function extractRtfText(
    bytes: Uint8Array,
    budget: LegacyParseBudget
): string {
    // The header is ASCII by definition, so this check needs no decoding.
    if (
        bytes.length < 5 ||
        String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !== "{\\rtf"
    ) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }

    let decodeBytes = singleByteDecoder(1252);
    const stack: GroupState[] = [{ unicodeSkip: 1 }];
    let out = "";
    let pendingSkip = 0;
    /**
     * The stack depth of the group a skipped destination opened.
     *
     * Skipping ends when *that* group closes, which is strictly shallower --
     * comparing against the depth itself ends it on the first nested `}`
     * instead, and a font table is nothing but nested groups. That off-by-one
     * put every font and style name into the extracted text.
     */
    let skipDepth = -1;

    const append = (text: string) => {
        if (!text) return;
        if (budget.charactersRemaining() < text.length) {
            throw new LegacyOfficeError("LEGACY_OFFICE_TOO_LARGE");
        }
        budget.claimCharacters(text.length);
        out += text;
    };

    /** Buffers a run of raw bytes so a multi-byte code page decodes correctly. */
    let byteRun: number[] = [];
    const flushBytes = () => {
        if (byteRun.length === 0) return;
        const text = decodeBytes(Uint8Array.from(byteRun));
        byteRun = [];
        if (skipDepth < 0) append(text);
    };

    let at = 0;
    while (at < bytes.length) {
        budget.tick();
        const byte = bytes[at];

        if (byte === 0x7b) {
            // `{`
            flushBytes();
            const parent = stack[stack.length - 1];
            stack.push({ unicodeSkip: parent.unicodeSkip });
            at += 1;
            continue;
        }

        if (byte === 0x7d) {
            // `}`
            flushBytes();
            if (stack.length > 1) stack.pop();
            if (skipDepth >= 0 && stack.length < skipDepth) skipDepth = -1;
            at += 1;
            continue;
        }

        if (byte === 0x5c) {
            // `\` -- an escape, a control word, or a control symbol.
            const next = at + 1 < bytes.length ? bytes[at + 1] : -1;

            if (next === 0x5c || next === 0x7b || next === 0x7d) {
                if (pendingSkip > 0) {
                    pendingSkip -= 1;
                } else {
                    byteRun.push(next);
                }
                at += 2;
                continue;
            }

            if (next === 0x27) {
                // `\'hh` -- one byte in the current code page.
                const hex = String.fromCharCode(bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
                const value = Number.parseInt(hex, 16);
                if (Number.isFinite(value)) {
                    if (pendingSkip > 0) pendingSkip -= 1;
                    else byteRun.push(value);
                }
                at += 4;
                continue;
            }

            if (next === 0x2a) {
                // `\*` -- "ignore this destination if you do not know it".
                at += 2;
                continue;
            }

            if (next >= 0 && !isLetter(next)) {
                // A control symbol: `\~` is a non-breaking space, `\-` an
                // optional hyphen, `\_` a non-breaking hyphen, and a `\` at a
                // line end is a paragraph mark.
                flushBytes();
                if (skipDepth < 0) {
                    if (next === 0x7e) append(" ");
                    else if (next === 0x5f) append("-");
                    else if (next === 0x0a || next === 0x0d) append("\n");
                }
                at += 2;
                continue;
            }

            // A control word: letters, an optional signed number, and one
            // optional space that belongs to the word rather than the text.
            let cursor = at + 1;
            while (cursor < bytes.length && isLetter(bytes[cursor])) cursor += 1;
            const word = String.fromCharCode(...bytes.subarray(at + 1, cursor));
            let numberText = "";
            if (cursor < bytes.length && (bytes[cursor] === 0x2d || isDigit(bytes[cursor]))) {
                const numberStart = cursor;
                if (bytes[cursor] === 0x2d) cursor += 1;
                while (cursor < bytes.length && isDigit(bytes[cursor])) cursor += 1;
                numberText = String.fromCharCode(...bytes.subarray(numberStart, cursor));
            }
            if (cursor < bytes.length && bytes[cursor] === 0x20) cursor += 1;
            at = cursor;

            const parameter = numberText === "" ? null : Number.parseInt(numberText, 10);
            const group = stack[stack.length - 1];

            if (SKIPPED_DESTINATIONS.has(word)) {
                flushBytes();
                if (skipDepth < 0) skipDepth = stack.length;
                continue;
            }

            if (word === "ansicpg" && parameter !== null) {
                flushBytes();
                decodeBytes = singleByteDecoder(parameter);
                continue;
            }

            if (word === "uc" && parameter !== null) {
                group.unicodeSkip = Math.max(0, Math.min(parameter, 64));
                continue;
            }

            if (word === "u" && parameter !== null) {
                flushBytes();
                // A negative value is the signed-16-bit spelling of a code
                // point above 0x7FFF, which is most of the CJK range.
                const codePoint = parameter < 0 ? parameter + 0x10000 : parameter;
                if (skipDepth < 0 && codePoint >= 0 && codePoint <= 0x10ffff) {
                    append(String.fromCodePoint(codePoint));
                }
                // The ASCII fallback that follows is the same character again.
                pendingSkip = group.unicodeSkip;
                continue;
            }

            if (word === "bin" && parameter !== null && parameter > 0) {
                // Binary payload measured in bytes: skipped wholesale rather
                // than scanned, so its contents can never be read as markup.
                flushBytes();
                at = Math.min(bytes.length, at + parameter);
                continue;
            }

            const literal = LITERAL_CONTROL_WORDS[word];
            if (literal !== undefined) {
                flushBytes();
                if (skipDepth < 0) append(literal);
                continue;
            }

            // Any other control word is formatting. It ends the pending
            // unicode fallback, because the fallback is characters and this is
            // not one.
            flushBytes();
            pendingSkip = 0;
            continue;
        }

        // Ordinary text. RTF's own line endings are not the document's.
        if (byte === 0x0d || byte === 0x0a) {
            at += 1;
            continue;
        }
        if (pendingSkip > 0) {
            pendingSkip -= 1;
            at += 1;
            continue;
        }
        byteRun.push(byte);
        at += 1;
    }

    flushBytes();
    return out;
}
