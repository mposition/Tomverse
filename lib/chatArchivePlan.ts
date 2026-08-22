/**
 * Deciding what an uploaded ZIP contains, before a single byte is inflated.
 *
 * Contract: docs/policy/chat-attachment-formats.md.
 *
 * Every limit in `lib/chatArchiveLimits.ts` is checked here, against the
 * central directory, which is the only place a ZIP states an entry's real
 * size. The local headers do not: a producer that streams (Google Takeout,
 * most `zip` implementations writing to a pipe) sets general-purpose flag bit
 * 3 and writes zeros, putting the sizes in a descriptor *after* the data. A
 * reader that trusts the local header therefore learns an entry's size only
 * once it has already inflated it, which is exactly too late for a
 * decompression bomb.
 *
 * So the order is: read the directory, refuse the archive or choose the
 * entries, and only then inflate the chosen ones -- and compare what came out
 * against what the directory promised (`lib/chatArchive.ts`). A descriptor
 * that lied about a size cannot spend more than the budget the directory
 * already agreed to.
 *
 * Pure: a `Uint8Array` in, a plan or a coded error out. No worker, no I/O, no
 * inflation, so the whole refusal matrix is testable without a fixture file
 * on disk.
 */

import {
    ARCHIVE_FATAL_EXTENSIONS,
    ARCHIVE_FATAL_FILENAMES,
    ARCHIVE_TOLERATED_BINARY_EXTENSIONS,
    EXECUTABLE_ATTACHMENT_EXTENSIONS,
    OTHER_ARCHIVE_EXTENSIONS,
    attachmentBaseName,
    attachmentFileExtension,
    resolveChatAttachmentFormat,
    type ChatAttachmentFormat,
} from "@/lib/chatAttachmentFormats";
import {
    CHAT_ARCHIVE_ERROR_CODES,
    type ChatArchiveErrorCode,
    type ChatArchiveExclusionReason,
    type ChatArchiveLimits,
} from "@/lib/chatArchiveLimits";

export class ChatArchivePlanError extends Error {
    constructor(public readonly code: ChatArchiveErrorCode) {
        super(code);
        this.name = "ChatArchivePlanError";
    }
}

export type PlannedArchiveEntry = {
    /** Separator-normalized, `.`-segment-free path, used for display and prompts. */
    readonly path: string;
    /**
     * The names the streaming reader may report for this entry.
     *
     * A ZIP stores a name as bytes and a flag saying whether they are UTF-8.
     * Plenty of producers write UTF-8 bytes and forget the flag, so a reader
     * that honours the flag decodes the same entry as Latin-1 mojibake while
     * the central-directory pass here decodes it as the Korean, Japanese or
     * accented name it actually is. Matching on either spelling is what keeps
     * a non-ASCII entry from silently disappearing between the two passes.
     */
    readonly matchNames: readonly string[];
    readonly format: ChatAttachmentFormat;
    readonly uncompressedBytes: number;
    readonly compressedBytes: number;
};

export type ChatArchivePlan = {
    readonly entries: readonly PlannedArchiveEntry[];
    /** Counts only. A path is attacker-controlled text and is never reported. */
    readonly exclusions: Readonly<Record<ChatArchiveExclusionReason, number>>;
    readonly totalEntries: number;
    /** Declared uncompressed bytes of the entries that will be inflated. */
    readonly selectedUncompressedBytes: number;
};

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL_ENTRY = 0x02014b50;
const EOCD_MIN_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

/** Deflate and store. Everything else -- bzip2, LZMA, zstd, AES -- is refused. */
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8]);

/** General-purpose bit 0 (encrypted) and bit 6 (strong encryption). */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;

/** Version-made-by host bytes that carry POSIX mode in the external attributes. */
const POSIX_HOST_SYSTEMS = new Set([3, 19]);
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

const emptyExclusions = (): Record<ChatArchiveExclusionReason, number> => ({
    "unsupported-format": 0,
    "nested-archive": 0,
    directory: 0,
    empty: 0,
    "beyond-file-limit": 0,
    "beyond-text-budget": 0,
    unreadable: 0,
});

const refuse = (code: ChatArchiveErrorCode): never => {
    throw new ChatArchivePlanError(code);
};

/**
 * The Latin-1 reading of a name, which is what a ZIP reader produces when the
 * archive did not set the UTF-8 flag. Built by hand rather than through a
 * `TextDecoder` label so it means the same thing in every runtime.
 */
const latin1 = (bytes: Uint8Array) => {
    let out = "";
    for (let index = 0; index < bytes.length; index += 1) {
        out += String.fromCharCode(bytes[index]);
    }
    return out;
};

const viewOf = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const findEocd = (bytes: Uint8Array) => {
    const view = viewOf(bytes);
    const earliest = Math.max(
        0,
        bytes.length - EOCD_MIN_BYTES - MAX_COMMENT_BYTES
    );
    for (let at = bytes.length - EOCD_MIN_BYTES; at >= earliest; at -= 1) {
        if (view.getUint32(at, true) === SIG_EOCD) return at;
    }
    return -1;
};

/**
 * Normalizes an entry name and refuses anything that could name a location
 * outside the archive.
 *
 * Both separators are folded first, because a mixed path (`a\\../b`) is only
 * a traversal once you have decided what a separator is -- and a ZIP written
 * on Windows genuinely uses backslashes. Everything after that is checked
 * against the folded form, so there is no second reading left over.
 */
const normalizeEntryPath = (rawName: string, limits: ChatArchiveLimits) => {
    if (rawName.includes("\u0000")) refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
    if (rawName.length === 0) refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
    if (rawName.length > limits.maxEntryPathLength) {
        refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
    }

    const folded = rawName.replaceAll("\\", "/");
    if (folded.startsWith("/")) refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
    // `C:/x`, and also the `C:x` form, which resolves against the drive's
    // current directory rather than its root.
    if (/^[A-Za-z]:/.test(folded)) refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
    // A UNC share, which `//` would otherwise read as an empty first segment.
    if (folded.startsWith("//")) refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);

    const isDirectory = folded.endsWith("/");
    const segments = folded.split("/").filter((segment) => segment !== "" && segment !== ".");
    for (const segment of segments) {
        if (segment === "..") refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
        if (segment.length > limits.maxEntryPathSegmentLength) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
        }
    }
    if (segments.length === 0) refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);

    return { path: segments.join("/"), isDirectory };
};

type DirectoryEntry = {
    matchNames: readonly string[];
    path: string;
    isDirectory: boolean;
    uncompressedBytes: number;
    compressedBytes: number;
};

/**
 * Walks the central directory and refuses the whole archive on anything
 * structural. Returns one record per entry, in directory order.
 */
const readCentralDirectory = (
    bytes: Uint8Array,
    limits: ChatArchiveLimits
): DirectoryEntry[] => {
    if (bytes.length < EOCD_MIN_BYTES || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        refuse(CHAT_ARCHIVE_ERROR_CODES.corrupt);
    }

    const eocdAt = findEocd(bytes);
    if (eocdAt < 0) refuse(CHAT_ARCHIVE_ERROR_CODES.corrupt);

    const view = viewOf(bytes);
    const diskNumber = view.getUint16(eocdAt + 4, true);
    const directoryDisk = view.getUint16(eocdAt + 6, true);
    const entriesOnDisk = view.getUint16(eocdAt + 8, true);
    const entryCount = view.getUint16(eocdAt + 10, true);
    const directorySize = view.getUint32(eocdAt + 12, true);
    const directoryOffset = view.getUint32(eocdAt + 16, true);

    // A ZIP64 locator immediately before the EOCD is the archive telling us
    // its real counts live elsewhere. Refused by name rather than read: the
    // formats this feature accepts are all far below 4GB, and a reader that
    // half-understands ZIP64 is worse than one that says so.
    const locatorAt = eocdAt - 20;
    const hasZip64Locator =
        locatorAt >= 0 && view.getUint32(locatorAt, true) === SIG_ZIP64_LOCATOR;
    if (
        hasZip64Locator ||
        entryCount === ZIP64_SENTINEL_16 ||
        entriesOnDisk === ZIP64_SENTINEL_16 ||
        directorySize === ZIP64_SENTINEL_32 ||
        directoryOffset === ZIP64_SENTINEL_32
    ) {
        refuse(CHAT_ARCHIVE_ERROR_CODES.zip64);
    }

    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
        refuse(CHAT_ARCHIVE_ERROR_CODES.corrupt);
    }
    if (entryCount === 0) refuse(CHAT_ARCHIVE_ERROR_CODES.noSupportedFiles);
    if (entryCount > limits.maxEntries) {
        refuse(CHAT_ARCHIVE_ERROR_CODES.tooManyEntries);
    }
    if (directoryOffset + directorySize > eocdAt) {
        refuse(CHAT_ARCHIVE_ERROR_CODES.corrupt);
    }

    const decoder = new TextDecoder("utf-8", { fatal: false });
    const entries: DirectoryEntry[] = [];
    const seenPaths = new Set<string>();
    let totalCompressed = 0;
    let totalUncompressed = 0;
    let at = directoryOffset;

    for (let index = 0; index < entryCount; index += 1) {
        if (at + 46 > bytes.length || view.getUint32(at, true) !== SIG_CENTRAL_ENTRY) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.corrupt);
        }

        const versionMadeBy = view.getUint16(at + 4, true);
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        const compressedBytes = view.getUint32(at + 20, true);
        const uncompressedBytes = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const externalAttributes = view.getUint32(at + 38, true);
        const nameAt = at + 46;
        const next = nameAt + nameLength + extraLength + commentLength;
        if (next > bytes.length || nameLength === 0) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.corrupt);
        }

        if ((flags & FLAG_ENCRYPTED) !== 0 || (flags & FLAG_STRONG_ENCRYPTION) !== 0) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.encrypted);
        }
        if (
            compressedBytes === ZIP64_SENTINEL_32 ||
            uncompressedBytes === ZIP64_SENTINEL_32
        ) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.zip64);
        }
        if (!SUPPORTED_COMPRESSION_METHODS.has(method)) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.unsupportedCompression);
        }

        const hostSystem = versionMadeBy >> 8;
        if (
            POSIX_HOST_SYSTEMS.has(hostSystem) &&
            ((externalAttributes >>> 16) & S_IFMT) === S_IFLNK
        ) {
            // A symlink entry's "content" is a path. Following it is the whole
            // Zip Slip family in one entry, and not following it means storing
            // a file whose bytes are a lie about what it is.
            refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
        }

        const nameBytes = bytes.subarray(nameAt, nameAt + nameLength);
        const rawName = decoder.decode(nameBytes);
        const matchNames = Array.from(new Set([rawName, latin1(nameBytes)]));
        const { path, isDirectory } = normalizeEntryPath(rawName, limits);

        if (isDirectory && uncompressedBytes !== 0) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
        }

        // Unicode-normalized, so two names that a filesystem would resolve to
        // the same file cannot both be present. Case is left alone: a
        // case-sensitive tree legitimately holds `README.md` and `readme.md`,
        // and refusing that would be refusing an ordinary source archive.
        const duplicateKey = (isDirectory ? `${path}/` : path).normalize("NFC");
        if (seenPaths.has(duplicateKey)) refuse(CHAT_ARCHIVE_ERROR_CODES.unsafePath);
        seenPaths.add(duplicateKey);

        if (uncompressedBytes > limits.maxEntryUncompressedBytes) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.entryTooLarge);
        }
        if (compressedBytes === 0 && uncompressedBytes > 0) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.compressionRatio);
        }
        if (
            compressedBytes > 0 &&
            uncompressedBytes / compressedBytes > limits.maxCompressionRatio
        ) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.compressionRatio);
        }

        totalCompressed += compressedBytes;
        totalUncompressed += uncompressedBytes;
        if (totalUncompressed > limits.maxTotalUncompressedBytes) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.expansionTooLarge);
        }
        if (
            totalCompressed > 0 &&
            totalUncompressed / totalCompressed > limits.maxCompressionRatio
        ) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.compressionRatio);
        }

        entries.push({
            matchNames,
            path,
            isDirectory,
            uncompressedBytes,
            compressedBytes,
        });
        at = next;
    }

    if (at > directoryOffset + directorySize) {
        refuse(CHAT_ARCHIVE_ERROR_CODES.corrupt);
    }

    return entries;
};

/**
 * Reads the directory, refuses the archive if anything about it is unsafe,
 * and picks the entries worth inflating.
 *
 * The selection is sorted by path so the same archive always produces the
 * same set in the same order -- the model sees a stable document sequence,
 * and so does a test.
 */
export function planChatArchive(
    bytes: Uint8Array,
    limits: ChatArchiveLimits
): ChatArchivePlan {
    if (bytes.length > limits.maxArchiveBytes) {
        refuse(CHAT_ARCHIVE_ERROR_CODES.entryTooLarge);
    }

    const directory = readCentralDirectory(bytes, limits);
    const exclusions = emptyExclusions();
    const candidates: PlannedArchiveEntry[] = [];

    for (const entry of directory) {
        if (entry.isDirectory) {
            exclusions.directory += 1;
            continue;
        }

        const base = attachmentBaseName(entry.path);
        const extension = attachmentFileExtension(entry.path);

        if (
            ARCHIVE_FATAL_EXTENSIONS.has(extension) ||
            ARCHIVE_FATAL_FILENAMES.has(base)
        ) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.credentialEntry);
        }
        if (
            EXECUTABLE_ATTACHMENT_EXTENSIONS.has(extension) &&
            !ARCHIVE_TOLERATED_BINARY_EXTENSIONS.has(extension)
        ) {
            refuse(CHAT_ARCHIVE_ERROR_CODES.executableEntry);
        }
        // Build output. Refused as an upload, skipped here: a source tree
        // ships a Gradle wrapper and a `node_modules`, and failing the whole
        // archive for them refuses the ordinary case.
        if (ARCHIVE_TOLERATED_BINARY_EXTENSIONS.has(extension)) {
            exclusions["unsupported-format"] += 1;
            continue;
        }
        // Another container. Not fatal -- a source tree ships one often
        // enough -- but never opened: nesting depth is zero by contract.
        if (extension === "zip" || OTHER_ARCHIVE_EXTENSIONS.has(extension)) {
            exclusions["nested-archive"] += 1;
            continue;
        }
        if (entry.uncompressedBytes === 0) {
            exclusions.empty += 1;
            continue;
        }

        const format = resolveChatAttachmentFormat({ filename: entry.path });
        if (!format || !format.allowedInArchive) {
            exclusions["unsupported-format"] += 1;
            continue;
        }

        candidates.push({
            path: entry.path,
            matchNames: entry.matchNames,
            format,
            uncompressedBytes: entry.uncompressedBytes,
            compressedBytes: entry.compressedBytes,
        });
    }

    candidates.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    const entries = candidates.slice(0, limits.maxProcessedFiles);
    exclusions["beyond-file-limit"] += candidates.length - entries.length;

    if (entries.length === 0) {
        refuse(CHAT_ARCHIVE_ERROR_CODES.noSupportedFiles);
    }

    return {
        entries,
        exclusions,
        totalEntries: directory.length,
        selectedUncompressedBytes: entries.reduce(
            (total, entry) => total + entry.uncompressedBytes,
            0
        ),
    };
}

/** How many entries were left out, for the notice the composer shows. */
export const totalArchiveExclusions = (
    exclusions: Readonly<Record<ChatArchiveExclusionReason, number>>
) =>
    (Object.keys(exclusions) as ChatArchiveExclusionReason[])
        // A directory is not a file anyone expected to be read, so counting it
        // would turn "3 files were skipped" into a number nobody can match to
        // what they zipped.
        .filter((reason) => reason !== "directory" && reason !== "empty")
        .reduce((total, reason) => total + exclusions[reason], 0);
