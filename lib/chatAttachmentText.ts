/**
 * Turning uploaded bytes into text, or refusing to.
 *
 * A text attachment is the one shape with no signature of its own: a `.py`, a
 * `.csv` and a renamed `.exe` all start with whatever their first byte
 * happens to be. Every other format in `lib/chatAttachmentFormats.ts` is
 * proven by a magic number and then by a parser; this one has to be proven by
 * decoding it, and by refusing everything that decodes badly.
 *
 * Three rules, and the third is the one that used to be missing:
 *
 *   1. A known binary signature or an embedded NUL is not text, whatever the
 *      name says.
 *   2. UTF-8 is the assumption. A BOM is honoured, and UTF-16 with a BOM is
 *      converted rather than refused -- a Windows editor writes UTF-16LE
 *      without being asked, and "your notes file is not text" is a wrong
 *      answer.
 *   3. Broken encoding is an error, not a repair. `Buffer.toString("utf8")`
 *      substitutes U+FFFD for every invalid sequence, so a mis-encoded file
 *      arrives looking like a decoded one with damage scattered through it --
 *      and the model is then asked to reason about the damage. Strict
 *      decoding turns that into a sentence the user can act on.
 *
 * Pure and isomorphic: `TextDecoder` and `Uint8Array` only, so the client can
 * pre-empt a rejection with the same code the server decides it with.
 */

export type AttachmentTextFailureReason =
    /** A known binary signature, or a NUL where text cannot have one. */
    | "binary"
    /** Not decodable as UTF-8, and not UTF-16 with a byte order mark. */
    | "encoding";

export type AttachmentTextResult =
    | { readonly ok: true; readonly text: string; readonly encoding: AttachmentTextEncoding }
    | { readonly ok: false; readonly reason: AttachmentTextFailureReason };

export type AttachmentTextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be";

/**
 * Container and executable headers. Not an exhaustive catalogue of binary
 * formats -- the NUL scan and the strict decode below catch the rest -- but
 * the ones worth naming, because a ZIP or a PE renamed to `.txt` is the
 * deliberate case rather than the accidental one.
 */
const BINARY_SIGNATURES: readonly (readonly number[])[] = [
    [0x50, 0x4b, 0x03, 0x04], // ZIP / OOXML
    [0x50, 0x4b, 0x05, 0x06], // empty ZIP
    [0x50, 0x4b, 0x07, 0x08], // spanned ZIP
    [0x1f, 0x8b], // gzip
    [0x42, 0x5a, 0x68], // bzip2
    [0xfd, 0x37, 0x7a, 0x58, 0x5a], // xz
    [0x52, 0x61, 0x72, 0x21], // RAR
    [0x37, 0x7a, 0xbc, 0xaf], // 7z
    [0x7f, 0x45, 0x4c, 0x46], // ELF
    [0x4d, 0x5a], // PE / DOS
    [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
    [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
    [0xd0, 0xcf, 0x11, 0xe0], // OLE / CFBF (legacy Office)
    [0x25, 0x50, 0x44, 0x46], // PDF
    [0x89, 0x50, 0x4e, 0x47], // PNG
    [0x47, 0x49, 0x46, 0x38], // GIF
    [0xff, 0xd8, 0xff], // JPEG
    [0x00, 0x61, 0x73, 0x6d], // WebAssembly
];

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
    bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte);

export const hasBinarySignature = (bytes: Uint8Array) =>
    BINARY_SIGNATURES.some((signature) => startsWith(bytes, signature));

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

const decodeStrict = (bytes: Uint8Array, encoding: string): string | null => {
    try {
        return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
};

/**
 * Decodes an attachment's bytes, or says why it will not.
 *
 * `bytes` is the whole file. Nothing here is streamed: every caller already
 * holds the buffer, and a partial decode cannot answer the encoding question
 * anyway -- an invalid sequence can be the last four bytes of the file.
 */
export function decodeAttachmentText(bytes: Uint8Array): AttachmentTextResult {
    if (bytes.length === 0) return { ok: true, text: "", encoding: "utf-8" };

    if (startsWith(bytes, UTF16LE_BOM) || startsWith(bytes, UTF16BE_BOM)) {
        // A UTF-16 file is half NUL bytes by construction, so the binary and
        // NUL checks below cannot run over it -- the byte order mark is the
        // evidence, and a strict decode is the proof.
        const littleEndian = startsWith(bytes, UTF16LE_BOM);
        const text = decodeStrict(
            bytes.subarray(2),
            littleEndian ? "utf-16le" : "utf-16be"
        );
        if (text === null) return { ok: false, reason: "encoding" };
        if (text.includes("\u0000")) return { ok: false, reason: "binary" };
        return {
            ok: true,
            text,
            encoding: littleEndian ? "utf-16le" : "utf-16be",
        };
    }

    if (hasBinarySignature(bytes)) return { ok: false, reason: "binary" };
    if (bytes.includes(0x00)) return { ok: false, reason: "binary" };

    const hasUtf8Bom = startsWith(bytes, UTF8_BOM);
    const body = hasUtf8Bom ? bytes.subarray(3) : bytes;
    const text = decodeStrict(body, "utf-8");
    if (text === null) return { ok: false, reason: "encoding" };
    return { ok: true, text, encoding: hasUtf8Bom ? "utf-8-bom" : "utf-8" };
}
