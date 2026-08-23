/**
 * The one entry point for reading a Word 97-2003, Excel 97-2003, PowerPoint
 * 97-2003 or RTF document.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * These four were left out of the first pass with a stated reason: there was
 * no safe parser for them in this tree, and `officeparser` reads only OOXML
 * and ODF. Allowing an extension that then fails to parse is the fake support
 * that policy forbids, so they stayed out until there was something behind
 * them. This is that something -- written here rather than pulled in, because
 * the maintained JavaScript options cover one of the four formats between
 * them, and the npm build of the obvious spreadsheet library carries a
 * prototype-pollution advisory that is fixed only in a release the registry
 * does not serve.
 *
 * What each parser does, and does not do, is in its own module. What they
 * share is here:
 *
 *   * every one is bounded by `lib/legacyOffice/budget.ts` before it reads;
 *   * none decrypts, so a protected document is refused by name;
 *   * none opens the macro storage, an embedded object or a picture;
 *   * none executes, evaluates or fetches anything;
 *   * a document that parses but says nothing is a refusal, not an empty
 *     string handed to a model as if it were the file's contents.
 */

import "server-only";

import {
    createLegacyParseBudget,
    LegacyOfficeError,
    type LegacyParseLimits,
} from "@/lib/legacyOffice/budget";
import { hasCompoundFileSignature } from "@/lib/legacyOffice/cfbf";
import { extractDocText } from "@/lib/legacyOffice/doc";
import { extractPptText } from "@/lib/legacyOffice/ppt";
import { extractRtfText } from "@/lib/legacyOffice/rtf";
import { extractXlsText } from "@/lib/legacyOffice/xls";

export {
    LegacyOfficeError,
    type LegacyOfficeErrorCode,
} from "@/lib/legacyOffice/budget";

/** The registry ids this module answers for. */
export type LegacyOfficeFormatId = "doc" | "xls" | "ppt" | "rtf";

const RTF_PREFIX = "{\\rtf";

const startsWithRtf = (bytes: Uint8Array) =>
    bytes.length >= RTF_PREFIX.length &&
    String.fromCharCode(...bytes.subarray(0, RTF_PREFIX.length)) === RTF_PREFIX;

/** A ZIP header where a compound file should be: a renamed `.docx`. */
const startsWithZip = (bytes: Uint8Array) =>
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);

/**
 * Proves the bytes are the shape the extension claims, before a parser runs.
 *
 * The `.doc` case is not pedantry. Word has shipped a "Save as .doc" that
 * writes RTF for twenty-five years, and mail systems rename attachments, so a
 * meaningful share of real `.doc` files are RTF wearing the wrong suffix.
 * Reading them as RTF is the honest answer -- the user gets their document --
 * where refusing on the signature would be technically correct and useless.
 * A `.docx` renamed to `.doc` is the opposite case: there is a right parser
 * for it and it is not this one, so that is a mismatch the user should fix.
 */
const resolveParser = (
    format: LegacyOfficeFormatId,
    bytes: Uint8Array
): LegacyOfficeFormatId => {
    if (format === "rtf") {
        if (!startsWithRtf(bytes)) throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
        return "rtf";
    }
    if (startsWithRtf(bytes)) {
        // Only Word ever did this; a spreadsheet or a deck that is really RTF
        // is a mislabelled file, not a compatibility case.
        if (format === "doc") return "rtf";
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }
    if (startsWithZip(bytes) || !hasCompoundFileSignature(bytes)) {
        throw new LegacyOfficeError("LEGACY_OFFICE_CORRUPT");
    }
    return format;
};

export type LegacyOfficeExtraction = {
    readonly text: string;
    /** Which parser actually ran, which is not always the extension's. */
    readonly parsedAs: LegacyOfficeFormatId;
};

/**
 * Reads one legacy document.
 *
 * Throws `LegacyOfficeError` for every outcome that is not text: a code the
 * caller maps to a sentence, never a parser message and never a file name.
 */
export function extractLegacyOfficeText(
    bytes: Uint8Array,
    format: LegacyOfficeFormatId,
    limits: Partial<LegacyParseLimits> = {}
): LegacyOfficeExtraction {
    const budget = createLegacyParseBudget(limits);
    const parsedAs = resolveParser(format, bytes);

    let text: string;
    switch (parsedAs) {
        case "doc":
            text = extractDocText(bytes, budget);
            break;
        case "xls":
            text = extractXlsText(bytes, budget);
            break;
        case "ppt":
            text = extractPptText(bytes, budget);
            break;
        case "rtf":
            text = extractRtfText(bytes, budget);
            break;
    }

    // Collapsed here rather than in four parsers: a legacy document is full of
    // structural line breaks that mean "new cell" or "new placeholder", and
    // three blank lines between two sentences is noise the model pays for.
    const cleaned = text
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    if (!cleaned) throw new LegacyOfficeError("LEGACY_OFFICE_NO_TEXT");
    return { text: cleaned, parsedAs };
}
