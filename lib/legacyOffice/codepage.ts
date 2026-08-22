/**
 * The single-byte code pages the legacy Office formats store text in.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * Word, Excel, PowerPoint and RTF all fall back to a single-byte page when a
 * run of text happens to be representable in one, and all four default to
 * Windows-1252. Decoding those bytes as Latin-1 -- which is what a naive
 * `latin1` read does -- is wrong in exactly the range real documents use
 * most: the curly quotes, the dashes and the ellipsis a word processor
 * inserts while you type all live in 0x80-0x9F, which Latin-1 leaves as
 * unprintable control characters.
 *
 * `TextDecoder("windows-1252")` exists in Node and in browsers, but the
 * mapping is written out here anyway: the other pages below have no decoder
 * label that is universally available, and one table that the tests can read
 * beats one table plus a runtime capability check.
 */

/** Windows-1252, in the range where it differs from Latin-1. */
const CP1252_HIGH = [
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
    0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
    0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
] as const;

/**
 * Decodes one byte in Windows-1252. Below 0x80 it is ASCII and above 0x9F it
 * is Latin-1; only the middle needs the table.
 */
export const decodeCp1252Byte = (byte: number) =>
    byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : byte;

export const decodeCp1252 = (bytes: Uint8Array): string => {
    let out = "";
    for (let index = 0; index < bytes.length; index += 1) {
        out += String.fromCharCode(decodeCp1252Byte(bytes[index]));
    }
    return out;
};

/**
 * The code pages an RTF file may name in `\ansicpgN`, mapped to a
 * `TextDecoder` label.
 *
 * Only the pages a decoder is actually available for are listed; an unknown
 * page falls back to Windows-1252 rather than failing the document, because
 * the alternative is refusing a file whose text is very likely ASCII anyway.
 */
const RTF_CODE_PAGE_LABELS: Readonly<Record<number, string>> = {
    874: "windows-874",
    932: "shift_jis",
    936: "gbk",
    949: "euc-kr",
    950: "big5",
    1250: "windows-1250",
    1251: "windows-1251",
    1252: "windows-1252",
    1253: "windows-1253",
    1254: "windows-1254",
    1255: "windows-1255",
    1256: "windows-1256",
    1257: "windows-1257",
    1258: "windows-1258",
    10000: "macintosh",
    65001: "utf-8",
};

/**
 * A decoder for a run of single-byte text in the named code page.
 *
 * Returns a function rather than a `TextDecoder` so the Windows-1252 path can
 * use the table above and the rest can use whatever the runtime provides,
 * with one shape at the call site. Never throws: a page the runtime cannot
 * build a decoder for degrades to Windows-1252, which is what the file would
 * have been read as before this existed.
 */
export function singleByteDecoder(codePage: number): (bytes: Uint8Array) => string {
    if (codePage === 1252 || !RTF_CODE_PAGE_LABELS[codePage]) return decodeCp1252;
    try {
        const decoder = new TextDecoder(RTF_CODE_PAGE_LABELS[codePage], {
            fatal: false,
        });
        // Proven on construction *and* on a byte, because a runtime can accept
        // the label and then produce replacement characters for everything.
        decoder.decode(Uint8Array.of(0x41));
        return (bytes) => decoder.decode(bytes);
    } catch {
        return decodeCp1252;
    }
}
