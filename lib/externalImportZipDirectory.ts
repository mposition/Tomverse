import { EXTERNAL_IMPORT_CLIENT_ARCHIVE_LIMITS as ARCHIVE_LIMITS } from "@/lib/externalImportLimits";

/**
 * Reads a ZIP's central directory so entry sizes are known before anything is
 * inflated.
 *
 * docs/policy/external-conversation-import-and-memory.md §5.1–§5.2.
 *
 * The archive walker decides what to parse from an entry's size, and until now
 * that size came from the local file header the streaming reader had just
 * passed. That works only when the producer knew the size before writing the
 * entry. Google Takeout does not: every entry it writes sets general-purpose
 * flag bit 3 (`0x0008`), which means the local header carries zeros and the
 * real sizes trail the data in a descriptor. A 5.5MB conversations file then
 * looked like a 0-byte one, was skipped as `empty`, and the export was
 * reported to the user as an HTML export it never was.
 *
 * The central directory has the sizes for every entry, always, and it sits at
 * the end of the file — which an uploaded `File` can seek to. Reading it first
 * keeps the property the walker is built on: every decision is made from
 * metadata, before a byte is inflated, so the per-entry and compression-ratio
 * budgets still bind.
 *
 * Pure and isomorphic: byte ranges arrive through a reader function, so the
 * tests run the same code the worker does without constructing a `File`.
 */

export type ZipDirectoryEntry = {
    /** Entry name exactly as the directory stores it. */
    name: string;
    uncompressedBytes: number;
    compressedBytes: number;
};

/** Reads `[start, end)` of the archive. End is exclusive, `Blob.slice` style. */
export type ZipByteRangeReader = (
    start: number,
    end: number
) => Promise<Uint8Array>;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL_ENTRY = 0x02014b50;

const EOCD_MIN_BYTES = 22;
/** A ZIP comment is a uint16 length, so the EOCD can be this far from the end. */
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_EXTRA_HEADER_ID = 0x0001;
/** Sizes at this sentinel live in the entry's ZIP64 extra field instead. */
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

const viewOf = (bytes: Uint8Array): DataView =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * A ZIP64 field is a uint64 but every limit in this contract is a JS number.
 * Anything past the safe range is refused rather than silently rounded — a
 * rounded size would be compared against a budget it no longer represents.
 */
const safeNumber = (value: bigint): number | null =>
    value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;

/**
 * Locates the End Of Central Directory record, which is the only fixed point
 * in a ZIP: it is last, except for a variable-length comment.
 */
function findEocd(bytes: Uint8Array): number | null {
    const view = viewOf(bytes);
    for (let i = bytes.length - EOCD_MIN_BYTES; i >= 0; i -= 1) {
        if (view.getUint32(i, true) === SIG_EOCD) return i;
    }
    return null;
}

type DirectoryLocation = { offset: number; size: number; entries: number };

/**
 * Where the central directory is, following the ZIP64 records when the 32-bit
 * fields are saturated. An archive this feature accepts is well under 4GB, but
 * a producer is free to write ZIP64 anyway, and a reader that assumes it never
 * does fails on exactly the large exports that matter most.
 */
async function locateDirectory(
    eocd: Uint8Array,
    eocdAt: number,
    tailStart: number,
    read: ZipByteRangeReader
): Promise<DirectoryLocation | null> {
    const view = viewOf(eocd);
    const entries = view.getUint16(eocdAt + 10, true);
    const size = view.getUint32(eocdAt + 12, true);
    const offset = view.getUint32(eocdAt + 16, true);

    const saturated =
        entries === ZIP64_SENTINEL_16 ||
        size === ZIP64_SENTINEL_32 ||
        offset === ZIP64_SENTINEL_32;
    if (!saturated) return { offset, size, entries };

    const locatorAt = eocdAt - 20;
    if (locatorAt < 0 || view.getUint32(locatorAt, true) !== SIG_ZIP64_LOCATOR) {
        return null;
    }
    const zip64At = safeNumber(view.getBigUint64(locatorAt + 8, true));
    if (zip64At === null) return null;

    // The ZIP64 EOCD may sit before the tail we already read.
    let zip64: Uint8Array;
    let zip64Offset: number;
    if (zip64At >= tailStart) {
        zip64 = eocd;
        zip64Offset = zip64At - tailStart;
    } else {
        zip64 = await read(zip64At, zip64At + 56);
        zip64Offset = 0;
    }
    if (zip64.length < zip64Offset + 56) return null;
    const zip64View = viewOf(zip64);
    if (zip64View.getUint32(zip64Offset, true) !== SIG_ZIP64_EOCD) return null;

    const zEntries = safeNumber(zip64View.getBigUint64(zip64Offset + 32, true));
    const zSize = safeNumber(zip64View.getBigUint64(zip64Offset + 40, true));
    const zOffset = safeNumber(zip64View.getBigUint64(zip64Offset + 48, true));
    if (zEntries === null || zSize === null || zOffset === null) return null;
    return { offset: zOffset, size: zSize, entries: zEntries };
}

/**
 * The ZIP64 extra field carries only the values that were saturated, in a
 * fixed order, so which u64 to read depends on what came before it.
 */
function zip64Sizes(
    extra: Uint8Array,
    uncompressedSaturated: boolean,
    compressedSaturated: boolean
): { uncompressedBytes?: number; compressedBytes?: number } | null {
    const view = viewOf(extra);
    let at = 0;
    while (at + 4 <= extra.length) {
        const id = view.getUint16(at, true);
        const size = view.getUint16(at + 2, true);
        const body = at + 4;
        if (body + size > extra.length) return null;
        if (id === ZIP64_EXTRA_HEADER_ID) {
            let cursor = body;
            const out: { uncompressedBytes?: number; compressedBytes?: number } = {};
            if (uncompressedSaturated) {
                if (cursor + 8 > body + size) return null;
                const value = safeNumber(view.getBigUint64(cursor, true));
                if (value === null) return null;
                out.uncompressedBytes = value;
                cursor += 8;
            }
            if (compressedSaturated) {
                if (cursor + 8 > body + size) return null;
                const value = safeNumber(view.getBigUint64(cursor, true));
                if (value === null) return null;
                out.compressedBytes = value;
            }
            return out;
        }
        at = body + size;
    }
    return null;
}

const utf8 = new TextDecoder("utf-8");

/**
 * Every entry's true size, keyed by name.
 *
 * Returns `null` — never throws and never guesses — when the directory cannot
 * be read: a truncated file, a spanned archive, a shape this parser does not
 * understand. The caller then falls back to local headers, which is what it
 * did before this existed. Failing soft matters because this runs ahead of
 * parsing on every archive, and an export that used to import must not stop
 * importing because its directory has an unusual extra field.
 */
export async function readZipCentralDirectory(
    totalBytes: number,
    read: ZipByteRangeReader,
    limits: typeof ARCHIVE_LIMITS = ARCHIVE_LIMITS
): Promise<Map<string, ZipDirectoryEntry> | null> {
    if (!Number.isFinite(totalBytes) || totalBytes < EOCD_MIN_BYTES) return null;

    try {
        const tailLength = Math.min(
            totalBytes,
            EOCD_MIN_BYTES + MAX_COMMENT_BYTES
        );
        const tailStart = totalBytes - tailLength;
        const tail = await read(tailStart, totalBytes);
        if (tail.length < EOCD_MIN_BYTES) return null;

        const eocdAt = findEocd(tail);
        if (eocdAt === null) return null;

        const location = await locateDirectory(tail, eocdAt, tailStart, read);
        if (!location) return null;
        const { offset, size, entries } = location;
        if (
            offset < 0 ||
            size < 0 ||
            offset + size > totalBytes ||
            entries > limits.maxArchiveEntries
        ) {
            // Not a refusal of the archive — the streaming walker enforces the
            // entry cap itself and reports it. This only declines to build a
            // map that would be wrong or unbounded.
            return null;
        }

        const directory =
            offset >= tailStart && offset + size <= totalBytes
                ? tail.subarray(offset - tailStart, offset - tailStart + size)
                : await read(offset, offset + size);
        if (directory.length < size) return null;

        const view = viewOf(directory);
        const found = new Map<string, ZipDirectoryEntry>();
        let at = 0;
        while (at + 46 <= directory.length) {
            if (view.getUint32(at, true) !== SIG_CENTRAL_ENTRY) return null;
            const compressedRaw = view.getUint32(at + 20, true);
            const uncompressedRaw = view.getUint32(at + 24, true);
            const nameLength = view.getUint16(at + 28, true);
            const extraLength = view.getUint16(at + 30, true);
            const commentLength = view.getUint16(at + 32, true);
            const nameAt = at + 46;
            const extraAt = nameAt + nameLength;
            const next = extraAt + extraLength + commentLength;
            if (next > directory.length) return null;

            let uncompressedBytes = uncompressedRaw;
            let compressedBytes = compressedRaw;
            const uncompressedSaturated = uncompressedRaw === ZIP64_SENTINEL_32;
            const compressedSaturated = compressedRaw === ZIP64_SENTINEL_32;
            if (uncompressedSaturated || compressedSaturated) {
                const sizes = zip64Sizes(
                    directory.subarray(extraAt, extraAt + extraLength),
                    uncompressedSaturated,
                    compressedSaturated
                );
                if (!sizes) return null;
                if (sizes.uncompressedBytes !== undefined) {
                    uncompressedBytes = sizes.uncompressedBytes;
                }
                if (sizes.compressedBytes !== undefined) {
                    compressedBytes = sizes.compressedBytes;
                }
            }

            // Names are decoded as UTF-8 regardless of the encoding flag: a
            // legacy CP437 name decodes to something else here, the lookup in
            // the worker misses, and that entry falls back to its local header
            // — the same place it read before. A wrong size is the one outcome
            // this must not produce.
            const name = utf8.decode(directory.subarray(nameAt, extraAt));
            found.set(name, { name, uncompressedBytes, compressedBytes });
            at = next;
        }

        if (found.size === 0) return null;
        return found;
    } catch {
        // Reader rejections included: an unreadable range is a reason to fall
        // back, not a reason to fail the import.
        return null;
    }
}

/** `readZipCentralDirectory` over an uploaded file. */
export async function readZipDirectoryFromBlob(
    file: Blob
): Promise<Map<string, ZipDirectoryEntry> | null> {
    return readZipCentralDirectory(file.size, async (start, end) => {
        const slice = await file.slice(start, end).arrayBuffer();
        return new Uint8Array(slice);
    });
}
